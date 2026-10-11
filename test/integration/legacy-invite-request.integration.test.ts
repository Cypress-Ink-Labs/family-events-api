import { readFileSync } from "node:fs"
import { join } from "node:path"

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { IdentityService } from "../../src/auth/identity.service.js"
import { OnboardingService } from "../../src/onboarding/onboarding.service.js"
import { ensureAdminCatalog } from "./admin-catalog.js"
import { createIntegrationDb } from "./db.js"

const db = createIntegrationDb()
const migration = "20261011003000_legacy_invite_request_outbox"
const sql = (name: string) => readFileSync(join(process.cwd(), name), "utf8")

async function requestInvite(email: string, message: string | null = null) {
  return db.withTransaction(async (client) => {
    await client.query("SET LOCAL ROLE anon")
    const result = await client.query<{ received: boolean }>(
      "SELECT public.request_invite($1,$2) AS received",
      [email, message]
    )
    return result.rows[0]!.received
  })
}

beforeAll(async () => {
  await ensureAdminCatalog(db)
  await db.query(`
    CREATE SCHEMA IF NOT EXISTS private;
    CREATE SCHEMA IF NOT EXISTS extensions;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
    END $$;
    GRANT USAGE ON SCHEMA public,private TO anon,authenticated;
    CREATE TABLE IF NOT EXISTS public.invite_requests(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),email text NOT NULL,message text,
      status text NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE IF NOT EXISTS public.invite_request_attempts(
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,email_hash text NOT NULL,
      attempted_at timestamptz NOT NULL DEFAULT now(),succeeded boolean NOT NULL
    );
    CREATE TABLE IF NOT EXISTS private.legacy_mail_fixture(payload jsonb NOT NULL);
    CREATE OR REPLACE FUNCTION private.dispatch_email_notification(p_payload jsonb) RETURNS void
      LANGUAGE sql AS $$ INSERT INTO private.legacy_mail_fixture VALUES(p_payload) $$;
    CREATE OR REPLACE FUNCTION private.is_invite_request_rate_limited(p_email_hash text)
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
      SELECT count(*) >= 3 FROM public.invite_request_attempts
      WHERE email_hash=p_email_hash AND attempted_at>now()-interval '10 minutes'
    $$;
  `)
  await db.query(sql("test/integration/sql/legacy_invite_request.sql"))
  await db.query(`
    CREATE OR REPLACE FUNCTION public.request_invite(p_email text,p_message text DEFAULT NULL)
      RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path TO '' AS $$
      SELECT private.request_invite(p_email,p_message)
    $$;
    REVOKE ALL ON FUNCTION private.request_invite(text,text),public.request_invite(text,text) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION private.request_invite(text,text),public.request_invite(text,text) TO anon,authenticated,service_role;
  `)
  await db.query("DROP TABLE IF EXISTS private.transactional_email_outbox")
  await db.query(sql("schema/migrations/20261008004000_transactional_invite_email.sql"))
})

beforeEach(async () => {
  await db.query(
    "TRUNCATE public.invite_requests,public.invite_request_attempts,private.legacy_mail_fixture,private.transactional_email_outbox"
  )
  await db.query(sql(`schema/migrations/${migration}.sql`))
})

afterAll(async () => {
  await db.onModuleDestroy()
})

describe("retained invitation RPC outbox migration", () => {
  it("keeps anonymous intake but replaces the legacy dispatch with one durable API entry", async () => {
    expect(await requestInvite(" Parent@Example.com ", "  Please invite us  ")).toBe(true)
    const requests = await db.query("SELECT id,email,message,status FROM public.invite_requests")
    expect(requests).toEqual([
      {
        id: expect.any(String),
        email: "parent@example.com",
        message: "Please invite us",
        status: "pending",
      },
    ])
    expect(
      await db.query(
        "SELECT dedupe_key,kind,target_id,payload,status,attempts FROM private.transactional_email_outbox"
      )
    ).toEqual([
      {
        dedupe_key: `admin_request:${requests[0]!.id}`,
        kind: "admin_request",
        target_id: requests[0]!.id,
        payload: { email: "parent@example.com", message: "Please invite us" },
        status: "pending",
        attempts: 0,
      },
    ])
    expect(await db.query("SELECT * FROM private.legacy_mail_fixture")).toEqual([])
  })

  it("preserves validation, message bounds, pending updates and the three-attempt window", async () => {
    expect(await requestInvite(" ")).toBe(false)
    expect(await requestInvite("invalid")).toBe(false)
    expect(await db.query("SELECT * FROM public.invite_request_attempts")).toEqual([])
    expect(await requestInvite("parent@example.com", "a".repeat(501))).toBe(true)
    expect(await requestInvite("PARENT@example.com", "updated")).toBe(true)
    expect(await requestInvite("parent@example.com", " ")).toBe(true)
    expect(await requestInvite("parent@example.com", "blocked")).toBe(false)
    expect(await db.query("SELECT email,message FROM public.invite_requests")).toEqual([
      { email: "parent@example.com", message: "updated" },
    ])
    expect(await db.query("SELECT count(*)::int AS n FROM public.invite_request_attempts")).toEqual(
      [{ n: 3 }]
    )
    expect(await db.query("SELECT payload FROM private.transactional_email_outbox")).toEqual([
      { payload: { email: "parent@example.com", message: "a".repeat(500) } },
    ])
    await db.query(
      "UPDATE public.invite_request_attempts SET attempted_at=now()-interval '11 minutes'"
    )
    expect(await requestInvite("parent@example.com", "after window")).toBe(true)
    expect(
      await db.query("SELECT count(*)::int AS n FROM private.transactional_email_outbox")
    ).toEqual([{ n: 1 }])
  })

  it("serializes concurrent requests with the API intake lock and queues one message", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => requestInvite("race@example.com"))
    )
    expect(results.filter(Boolean)).toHaveLength(3)
    expect(await db.query("SELECT count(*)::int AS n FROM public.invite_requests")).toEqual([
      { n: 1 },
    ])
    expect(
      await db.query("SELECT count(*)::int AS n FROM private.transactional_email_outbox")
    ).toEqual([{ n: 1 }])
    expect(await db.query("SELECT count(*)::int AS n FROM public.invite_request_attempts")).toEqual(
      [{ n: 3 }]
    )
  })

  it("shares request ownership and deduplication with concurrent API intake", async () => {
    const onboarding = new OnboardingService(db, new IdentityService(db))
    await Promise.all([
      requestInvite("shared@example.com", "legacy"),
      onboarding.request("shared@example.com", "API"),
      requestInvite("SHARED@example.com", "legacy retry"),
      onboarding.request("shared@example.com", "API retry"),
    ])
    expect(await db.query("SELECT count(*)::int AS n FROM public.invite_requests")).toEqual([
      { n: 1 },
    ])
    expect(
      await db.query("SELECT count(*)::int AS n FROM private.transactional_email_outbox")
    ).toEqual([{ n: 1 }])
    expect(await db.query("SELECT count(*)::int AS n FROM public.invite_request_attempts")).toEqual(
      [{ n: 3 }]
    )
    expect(await db.query("SELECT * FROM private.legacy_mail_fixture")).toEqual([])
  })

  it("keeps request and email intent atomic when durable storage is unavailable", async () => {
    await db.query(
      "ALTER TABLE private.transactional_email_outbox ADD CONSTRAINT reject_fixture_request CHECK(kind<>'admin_request')"
    )
    try {
      await expect(requestInvite("failure@example.com")).rejects.toMatchObject({ code: "23514" })
      expect(await db.query("SELECT * FROM public.invite_requests")).toEqual([])
      expect(await db.query("SELECT * FROM public.invite_request_attempts")).toEqual([])
    } finally {
      await db.query(
        "ALTER TABLE private.transactional_email_outbox DROP CONSTRAINT reject_fixture_request"
      )
    }
  })

  it("retains private outbox isolation and supports rollback followed by reapplication", async () => {
    await expect(
      db.withTransaction(async (client) => {
        await client.query("SET LOCAL ROLE anon")
        await client.query("SELECT * FROM private.transactional_email_outbox")
      })
    ).rejects.toMatchObject({ code: "42501" })
    await db.query(sql(`schema/migrations/${migration}_down.sql`))
    expect(await requestInvite("rollback@example.com")).toBe(true)
    expect(await db.query("SELECT payload FROM private.legacy_mail_fixture")).toEqual([
      {
        payload: expect.objectContaining({ kind: "admin_request", email: "rollback@example.com" }),
      },
    ])
    expect(await db.query("SELECT * FROM private.transactional_email_outbox")).toEqual([])
    await db.query(sql(`schema/migrations/${migration}.sql`))
    expect(await requestInvite("reapplied@example.com")).toBe(true)
    expect(
      await db.query("SELECT count(*)::int AS n FROM private.transactional_email_outbox")
    ).toEqual([{ n: 1 }])
    expect(await db.query("SELECT count(*)::int AS n FROM private.legacy_mail_fixture")).toEqual([
      { n: 1 },
    ])
  })
})
