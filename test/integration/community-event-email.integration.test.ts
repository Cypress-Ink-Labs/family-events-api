import { ConfigService } from "@nestjs/config"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import type { Env } from "../../src/config/env.js"
import { AdminReviewRepository } from "../../src/admin/admin-review.repository.js"
import type { DbService } from "../../src/db/db.service.js"
import type { JobsService } from "../../src/jobs/jobs.service.js"
import { MailService } from "../../src/notifications/mail.service.js"
import { TransactionalEmailService } from "../../src/transactional-email/transactional-email.service.js"
import { ensureAdminCatalog } from "./admin-catalog.js"
import { createIntegrationDb } from "./db.js"

const MIGRATION = "20261008008000_community_event_email"
const migration = (suffix = "") =>
  join(process.cwd(), "schema/migrations", `${MIGRATION}${suffix}.sql`)
let db: DbService
let config: ConfigService<Env, true>
let worker: TransactionalEmailService
let submitter: string

beforeAll(async () => {
  db = createIntegrationDb()
  await ensureAdminCatalog(db)
  await db.query(`
    DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
    ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email text;
    ALTER TABLE public.events ADD COLUMN IF NOT EXISTS submitted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
    ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_submitted_by_fkey;
    ALTER TABLE public.events ADD CONSTRAINT events_submitted_by_fkey FOREIGN KEY(submitted_by) REFERENCES auth.users(id) ON DELETE SET NULL;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
    END $$;
    DROP TABLE IF EXISTS private.transactional_email_outbox;
    DROP TRIGGER IF EXISTS cancel_deleted_community_email ON auth.users;
    DROP FUNCTION IF EXISTS private.cancel_deleted_community_email();
    CREATE TABLE IF NOT EXISTS private.clerk_user_lifecycle(clerk_user_id text PRIMARY KEY,storage_uuid uuid,deleted_at timestamptz);
    CREATE TABLE IF NOT EXISTS private.account_deletions(user_id uuid PRIMARY KEY,status text NOT NULL);
    CREATE SCHEMA IF NOT EXISTS net;
    CREATE TABLE net.community_email_calls(id bigint GENERATED ALWAYS AS IDENTITY,url text);
    CREATE OR REPLACE FUNCTION net.http_post(url text,body jsonb,headers jsonb) RETURNS bigint LANGUAGE plpgsql AS $$
      DECLARE result bigint;
      BEGIN INSERT INTO net.community_email_calls(url) VALUES(url) RETURNING id INTO result; RETURN result; END;
    $$;
  `)
  await db.query(
    readFileSync("schema/migrations/20261008004000_transactional_invite_email.sql", "utf8")
  )
  await db.query(
    readFileSync("test/integration/sql/community_event_status_notification.sql", "utf8")
  )
  await db.query(readFileSync(migration(), "utf8"))
  config = new ConfigService({
    NODE_ENV: "production",
    CUTOVER_NOTIFY: "true",
    RESEND_API_KEY: "re_fixture",
    RESEND_FROM: "Family Events <hello@example.com>",
    RESEND_REPLY_TO: "support@example.com",
    APP_URL: "https://app.example.com",
  }) as ConfigService<Env, true>
  worker = new TransactionalEmailService(db, config, new MailService(config), {} as JobsService)
})
afterAll(async () => {
  await db?.query(
    "DROP FUNCTION IF EXISTS net.http_post(text,jsonb,jsonb); DROP TABLE IF EXISTS net.community_email_calls"
  )
  await db?.onModuleDestroy()
})
afterEach(() => vi.unstubAllGlobals())
beforeEach(async () => {
  await db.query(
    "TRUNCATE public.events,auth.users,private.transactional_email_outbox,private.clerk_user_lifecycle,private.account_deletions,net.community_email_calls CASCADE"
  )
  submitter = randomUUID()
  await db.query("INSERT INTO auth.users(id,email) VALUES($1,'parent@example.com')", [submitter])
  await db.query("INSERT INTO public.user_profiles(id,display_name) VALUES($1,'Parent <Family>')", [
    submitter,
  ])
  config.set("CUTOVER_NOTIFY", "true")
  config.set("RESEND_REPLY_TO", "support@example.com")
})
async function event(owner: string | null = submitter) {
  const id = randomUUID()
  await db.query(
    "INSERT INTO public.events(id,title,status,start_datetime,submitted_by) VALUES($1,'Library <Stories>','draft','2026-10-20T15:00:00Z',$2)",
    [id, owner]
  )
  return id
}
async function status(id: string, value: string) {
  return db.withTransaction(async (client) => {
    await client.query(
      "SELECT set_config('app.settings.supabase_url','https://legacy.example.com',true),set_config('app.settings.service_role_key','fixture',true)"
    )
    await client.query("UPDATE public.events SET status=$2 WHERE id=$1", [id, value])
  })
}
function provider(responseStatus = 200) {
  const send = vi.fn(
    async (_input: string, _init: RequestInit) =>
      new Response(JSON.stringify({ id: "em_fixture" }), { status: responseStatus })
  )
  vi.stubGlobal("fetch", send)
  return send
}

describe("community event status delivery", () => {
  it("reserves the submitter's email through the actual operator status RPC", async () => {
    const actor = randomUUID()
    await db.query("INSERT INTO auth.users(id,email) VALUES($1,'operator@example.com')", [actor])
    await db.query("INSERT INTO public.user_profiles(id,role) VALUES($1,'admin')", [actor])
    await db.query("INSERT INTO public.user_access(user_id,is_enabled) VALUES($1,true)", [actor])
    const id = await event()
    await new AdminReviewRepository(db).setStatus(actor, id, "published", null)
    expect(await db.query("SELECT kind,target_id FROM private.transactional_email_outbox")).toEqual(
      [{ kind: "community_event_approved", target_id: submitter }]
    )
    expect(
      await db.query("SELECT id,status,submitted_by FROM public.events WHERE id=$1", [id])
    ).toEqual([{ id, status: "published", submitted_by: submitter }])
  })
  it.each(["published", "rejected"])(
    "queues %s atomically without calling the legacy dispatcher",
    async (value) => {
      const id = await event()
      await status(id, value)
      expect(
        await db.query(
          "SELECT kind,target_id,payload,status FROM private.transactional_email_outbox"
        )
      ).toEqual([
        {
          kind: value === "published" ? "community_event_approved" : "community_event_rejected",
          target_id: submitter,
          payload: {
            email: "parent@example.com",
            username: "Parent <Family>",
            event_title: "Library <Stories>",
            event_id: id,
          },
          status: "pending",
        },
      ])
      expect(await db.query("SELECT * FROM net.community_email_calls")).toEqual([])
    }
  )
  it("keeps repeat status writes idempotent while notifying subsequent decisions", async () => {
    const id = await event()
    await Promise.all([status(id, "published"), status(id, "published")])
    await status(id, "rejected")
    await status(id, "published")
    expect(
      (
        await db.query("SELECT kind FROM private.transactional_email_outbox ORDER BY created_at,id")
      ).map((row) => row.kind)
    ).toEqual(["community_event_approved", "community_event_rejected", "community_event_approved"])
  })
  it("ignores imported events, draft changes and absent submitter contact", async () => {
    await status(await event(null), "published")
    const id = await event()
    await status(id, "draft")
    await db.query("UPDATE auth.users SET email=NULL WHERE id=$1", [submitter])
    await status(id, "rejected")
    expect(await db.query("SELECT id FROM private.transactional_email_outbox")).toEqual([])
  })
  it("rolls back a status decision when its durable notification cannot be saved", async () => {
    const id = await event()
    await db.query(`CREATE FUNCTION private.reject_community_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture outbox failure'; END $$;
      CREATE TRIGGER reject_community_outbox BEFORE INSERT ON private.transactional_email_outbox FOR EACH ROW EXECUTE FUNCTION private.reject_community_outbox()`)
    try {
      await expect(status(id, "published")).rejects.toThrow("fixture outbox failure")
      expect(await db.query("SELECT status FROM public.events WHERE id=$1", [id])).toEqual([
        { status: "draft" },
      ])
      expect(await db.query("SELECT id FROM private.transactional_email_outbox")).toEqual([])
    } finally {
      await db.query(
        "DROP TRIGGER reject_community_outbox ON private.transactional_email_outbox; DROP FUNCTION private.reject_community_outbox()"
      )
    }
  })
  it.each(["published", "rejected"])(
    "delivers %s with escaped content and the canonical action link",
    async (value) => {
      const id = await event()
      await status(id, value)
      const send = provider()
      await worker.handleJob({ task: "process" })
      const payload = JSON.parse(String(send.mock.calls[0]?.[1]?.body))
      expect(payload).toMatchObject({
        to: "parent@example.com",
        from: "Family Events <hello@example.com>",
        reply_to: "support@example.com",
      })
      expect(payload.html).toContain("Parent &lt;Family&gt;")
      expect(payload.html).toContain("Library &lt;Stories&gt;")
      expect(payload.html).toContain(
        value === "published"
          ? `https://app.example.com/events/${id}`
          : "https://app.example.com/submit-event"
      )
      expect(
        await db.query("SELECT status,payload,delivery FROM private.transactional_email_outbox")
      ).toEqual([{ status: "sent", payload: null, delivery: null }])
    }
  )
  it("preserves the original reply address and provider body/key through retries", async () => {
    await status(await event(), "published")
    const refused = provider(503)
    await worker.handleJob({ task: "process" })
    const first = refused.mock.calls[0]?.[1]
    config.set("RESEND_REPLY_TO", "changed@example.com")
    await db.query("UPDATE private.transactional_email_outbox SET next_attempt_at=now()")
    const accepted = provider()
    await worker.handleJob({ task: "process" })
    expect(accepted.mock.calls[0]?.[1]?.body).toBe(first?.body)
    expect(accepted.mock.calls[0]?.[1]?.headers).toEqual(first?.headers)
    expect(
      await db.query("SELECT status,attempts FROM private.transactional_email_outbox")
    ).toEqual([{ status: "sent", attempts: 2 }])
  })
  it("keeps pending community delivery paused when notify ownership is disabled", async () => {
    await status(await event(), "published")
    config.set("CUTOVER_NOTIFY", "false")
    const send = provider()
    await expect(worker.handleJob({ task: "process" })).rejects.toThrow("ownership is disabled")
    expect(send).not.toHaveBeenCalled()
    expect(
      await db.query("SELECT status,attempts FROM private.transactional_email_outbox")
    ).toEqual([{ status: "pending", attempts: 0 }])
  })
  it("scrubs unsent community delivery when the recipient is deleted while preserving accepted mail", async () => {
    const id = await event()
    await status(id, "published")
    provider()
    await worker.handleJob({ task: "process" })
    await status(id, "rejected")
    await db.query("DELETE FROM auth.users WHERE id=$1", [submitter])
    expect(
      await db.query(
        "SELECT kind,status,payload,delivery FROM private.transactional_email_outbox ORDER BY created_at,id"
      )
    ).toEqual([
      { kind: "community_event_approved", status: "sent", payload: null, delivery: null },
      { kind: "community_event_rejected", status: "cancelled", payload: null, delivery: null },
    ])
    expect(await db.query("SELECT id,submitted_by FROM public.events WHERE id=$1", [id])).toEqual([
      { id, submitted_by: null },
    ])
  })
  it("does not dispatch or reserve more mail after a recipient's retained UUID is tombstoned", async () => {
    const id = await event()
    await status(id, "published")
    await db.query(
      "INSERT INTO private.clerk_user_lifecycle(clerk_user_id,storage_uuid,deleted_at) VALUES('user_deleted',$1,now())",
      [submitter]
    )
    await status(id, "rejected")
    const send = provider()
    await worker.handleJob({ task: "process" })
    expect(send).not.toHaveBeenCalled()
    expect(
      await db.query("SELECT kind,status,payload,delivery FROM private.transactional_email_outbox")
    ).toEqual([
      { kind: "community_event_approved", status: "cancelled", payload: null, delivery: null },
    ])
    expect(await db.query("SELECT id FROM auth.users WHERE id=$1", [submitter])).toEqual([
      { id: submitter },
    ])
  })
  it("scrubs a status delivery committed while legacy recipient deletion waits to finish", async () => {
    const id = await event()
    const pause = await db.pool.connect()
    await pause.query("SELECT pg_advisory_lock(80408001)")
    await db.query(`CREATE FUNCTION private.pause_community_deletion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(80408001); RETURN OLD; END $$;
      CREATE TRIGGER zzz_pause_community_deletion BEFORE DELETE ON auth.users FOR EACH ROW EXECUTE FUNCTION private.pause_community_deletion()`)
    const deletion = db.query("DELETE FROM auth.users WHERE id=$1", [submitter])
    try {
      await vi.waitFor(async () => {
        expect(
          await db.query(
            "SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid=80408001 AND NOT granted"
          )
        ).toHaveLength(1)
      })
      await status(id, "published")
      await pause.query("SELECT pg_advisory_unlock(80408001)")
      await deletion
      expect(
        await db.query("SELECT status,payload,delivery FROM private.transactional_email_outbox")
      ).toEqual([{ status: "cancelled", payload: null, delivery: null }])
    } finally {
      await pause.query("SELECT pg_advisory_unlock(80408001)")
      pause.release()
      await deletion
      await db.query(
        "DROP TRIGGER zzz_pause_community_deletion ON auth.users; DROP FUNCTION private.pause_community_deletion()"
      )
    }
  })
  it("refuses schema rollback until durable community outcomes are reconciled", async () => {
    const id = await event()
    await status(id, "published")
    const before = await db.query("SELECT id,kind,payload FROM private.transactional_email_outbox")
    await expect(
      db.withTransaction((client) => client.query(readFileSync(migration("_down"), "utf8")))
    ).rejects.toThrow("Export and reconcile")
    expect(
      await db.query("SELECT id,kind,payload FROM private.transactional_email_outbox")
    ).toEqual(before)
    await status(id, "rejected")
    expect(await db.query("SELECT * FROM net.community_email_calls")).toEqual([])
  })
  it("restores legacy dispatch on a clean rollback and re-enables outbox delivery on reapply", async () => {
    const id = await event()
    await db.withTransaction((client) => client.query(readFileSync(migration("_down"), "utf8")))
    try {
      await status(id, "published")
      expect(await db.query("SELECT url FROM net.community_email_calls")).toEqual([
        { url: "https://legacy.example.com/functions/v1/notify-email" },
      ])
      expect(await db.query("SELECT id FROM private.transactional_email_outbox")).toEqual([])
    } finally {
      await db.withTransaction((client) => client.query(readFileSync(migration(), "utf8")))
    }
    await db.query("TRUNCATE net.community_email_calls")
    await status(id, "rejected")
    expect(await db.query("SELECT kind FROM private.transactional_email_outbox")).toEqual([
      { kind: "community_event_rejected" },
    ])
    expect(await db.query("SELECT * FROM net.community_email_calls")).toEqual([])
  })
})
