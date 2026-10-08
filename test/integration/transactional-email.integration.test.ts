import { createHmac, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { type INestApplication } from "@nestjs/common"
import { ConfigModule, ConfigService } from "@nestjs/config"
import { Test } from "@nestjs/testing"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { AdminUserController } from "../../src/admin/admin-user.controller.js"
import { AdminUserRepository } from "../../src/admin/admin-user.repository.js"
import { AdminUserService } from "../../src/admin/admin-user.service.js"

import { OnboardingModule } from "../../src/onboarding/onboarding.module.js"

import { JobsService } from "../../src/jobs/jobs.service.js"
import { JobsModule } from "../../src/jobs/jobs.module.js"
import { TransactionalEmailService } from "../../src/transactional-email/transactional-email.service.js"
import { TransactionalEmailModule } from "../../src/transactional-email/transactional-email.module.js"
import { AdminInviteController } from "../../src/admin/admin-invite.controller.js"
import { AdminInviteRepository } from "../../src/admin/admin-invite.repository.js"
import { AdminInviteService } from "../../src/admin/admin-invite.service.js"
import { AuthModule } from "../../src/auth/auth.module.js"
import { IdentityService } from "../../src/auth/identity.service.js"
import { DbModule } from "../../src/db/db.module.js"
import { DbService } from "../../src/db/db.service.js"
import { ensureAdminCatalog } from "./admin-catalog.js"
import { integrationDatabaseUrl } from "./db.js"

const provider = vi.hoisted(() => ({ users: { getUser: vi.fn() } }))
vi.mock("@clerk/backend", () => ({
  createClerkClient: () => provider,
  verifyToken: async (token: string) => {
    if (token === "operator-token") return { sub: "user_operator" }
    if (token !== "old-parent-token") throw new Error("invalid token")
    return { sub: "user_parent" }
  },
}))
const SIGNING_SECRET = `whsec_${Buffer.from("disposable-webhook-signing-fixture").toString("base64")}`
const MIGRATION = "20261008001000_clerk_lifecycle"
let app: INestApplication
let db: DbService
let identity: IdentityService

function deliver(type: string, id = "user_parent", headers?: Record<string, string>) {
  const payload = JSON.stringify({ type, data: { id }, object: "event" })
  const eventId = `msg_${randomUUID()}`
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const signature = createHmac("sha256", Buffer.from(SIGNING_SECRET.slice(6), "base64"))
    .update(`${eventId}.${timestamp}.${payload}`)
    .digest("base64")
  return request(app.getHttpServer())
    .post("/webhooks/clerk")
    .set({
      "svix-id": eventId,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${signature}`,
      ...headers,
    })
    .set("Content-Type", "application/json")
    .send(payload)
}

function verifiedUser(id = "user_parent", email = "parent@example.com", updatedAt = 1000) {
  return {
    id,
    primaryEmailAddressId: "email_primary",
    emailAddresses: [
      { id: "email_primary", emailAddress: email, verification: { status: "verified" } },
    ],
    updatedAt,
    firstName: "Parent",
    lastName: "Family",
    publicMetadata: { role: "operator" },
    unsafeMetadata: { supabase_uuid: randomUUID() },
  }
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [
          () => ({
            DATABASE_URL: integrationDatabaseUrl(),
            NODE_ENV: "test",
            PGBOSS_SCHEMA: "pgboss_invite_email",
            RESEND_API_KEY: "re_fixture",
            RESEND_FROM: "Family Events <hello@example.com>",
            APP_URL: "https://app.example.com",
            ADMIN_NOTIFY_EMAIL: "operator@example.com",
            CLERK_SECRET_KEY: "sk_test_fixture",
            CLERK_WEBHOOK_SIGNING_SECRET: SIGNING_SECRET,
          }),
        ],
      }),
      DbModule,
      AuthModule,
      JobsModule,
      TransactionalEmailModule,
      OnboardingModule,
    ],
    controllers: [AdminUserController, AdminInviteController],
    providers: [AdminUserRepository, AdminUserService, AdminInviteRepository, AdminInviteService],
  }).compile()
  app = moduleRef.createNestApplication({ rawBody: true })
  await app.init()
  db = app.get(DbService)
  identity = app.get(IdentityService)
  await db.query(
    "CREATE SCHEMA IF NOT EXISTS auth; CREATE TABLE IF NOT EXISTS auth.users(id uuid PRIMARY KEY); DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users"
  )
  await ensureAdminCatalog(db)
  await db.query(`
    ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email text,
      ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz,
      ADD COLUMN IF NOT EXISTS raw_app_meta_data jsonb,
      ADD COLUMN IF NOT EXISTS raw_user_meta_data jsonb,
      ADD COLUMN IF NOT EXISTS created_at timestamptz,
      ADD COLUMN IF NOT EXISTS updated_at timestamptz;
    DROP TABLE IF EXISTS public.clerk_user_mapping;
    CREATE TABLE public.clerk_user_mapping (
      clerk_user_id text PRIMARY KEY CONSTRAINT clerk_user_mapping_clerk_id_shape_chk CHECK (clerk_user_id ~ '^user_'),
      supabase_uuid uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
      email text NOT NULL, role text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'operator')),
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS public.pending_invite_claims (
      email text PRIMARY KEY, invite_code text NOT NULL, expires_at timestamptz NOT NULL,
      claimed_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL, claimed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS private.clerk_lifecycle_policy_fixture (require_invite boolean NOT NULL);
    TRUNCATE private.clerk_lifecycle_policy_fixture;
    INSERT INTO private.clerk_lifecycle_policy_fixture VALUES(false);
    CREATE OR REPLACE FUNCTION private.invites_required() RETURNS boolean LANGUAGE sql AS $$
      SELECT require_invite FROM private.clerk_lifecycle_policy_fixture
    $$;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
    END $$;
  `)
  await db.query(
    "DROP TRIGGER IF EXISTS tombstone_deleted_clerk_user ON auth.users; DROP FUNCTION IF EXISTS private.tombstone_deleted_clerk_user(); DROP TABLE IF EXISTS private.clerk_user_lifecycle"
  )
  await db.query(readFileSync(join(process.cwd(), "schema/migrations", `${MIGRATION}.sql`), "utf8"))
  await db.query(`
    CREATE TABLE IF NOT EXISTS public.invite_request_attempts(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,email_hash text NOT NULL,attempted_at timestamptz NOT NULL DEFAULT now(),succeeded boolean NOT NULL);
    CREATE TABLE IF NOT EXISTS public.invite_redemption_attempts(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,email_hash text NOT NULL,attempted_at timestamptz NOT NULL DEFAULT now(),succeeded boolean NOT NULL);
  `)
  await db.query(
    readFileSync(join(process.cwd(), "test/integration/sql/onboarding_rpcs.sql"), "utf8")
  )
  await db.query("DROP TABLE IF EXISTS private.transactional_email_outbox")
  await db.query(
    readFileSync(
      join(process.cwd(), "schema/migrations/20261008004000_transactional_invite_email.sql"),
      "utf8"
    )
  )
  await db.query(`CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user()`)
})
afterAll(async () => {
  await db?.query("DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users")
  await app?.close()
})
beforeEach(async () => {
  provider.users.getUser.mockReset()
  await db.query("UPDATE private.clerk_lifecycle_policy_fixture SET require_invite=false")
  await db.query(
    "TRUNCATE private.clerk_user_lifecycle, auth.users, public.clerk_user_mapping, public.pending_invite_claims,public.invite_codes,public.invite_requests,public.invite_request_attempts,public.invite_redemption_attempts,private.transactional_email_outbox CASCADE"
  )
})

async function operator() {
  const id = randomUUID()
  await db.query(
    "INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,'operator@example.com',now())",
    [id]
  )
  await db.query("UPDATE public.user_profiles SET role='admin' WHERE id=$1", [id])
  await db.query("UPDATE public.user_access SET is_enabled=true WHERE user_id=$1", [id])
  provider.users.getUser.mockResolvedValue(verifiedUser("user_operator", "operator@example.com"))
  expect((await deliver("user.created", "user_operator")).status).toBe(200)
}
function admin(method: "get" | "post", path: string, body = {}) {
  return request(app.getHttpServer())
    [method](path)
    .set("Authorization", "Bearer operator-token")
    .send(body)
}
describe("Transactional invitation email HTTP", () => {
  it("rolls back email ownership without retyping or deleting invitation outcomes and audit evidence", async () => {
    await operator()
    await request(app.getHttpServer())
      .post("/v1/onboarding/requests")
      .send({ email: "invitee@example.com" })
    const rows = await admin("get", "/v1/admin/invite-requests")
    expect(
      (await admin("post", `/v1/admin/invite-requests/${rows.body[0].id}/approve`)).status
    ).toBe(200)
    const before = await db.query("SELECT id,status,invite_code_id FROM public.invite_requests")
    const auditBefore = await db.query("SELECT id FROM public.admin_audit_log ORDER BY id")
    await db.query(
      readFileSync(
        join(process.cwd(), "schema/migrations/20261008004000_transactional_invite_email_down.sql"),
        "utf8"
      )
    )
    try {
      expect(await db.query("SELECT id,status,invite_code_id FROM public.invite_requests")).toEqual(
        before
      )
      expect(await db.query("SELECT id FROM public.admin_audit_log ORDER BY id")).toEqual(
        auditBefore
      )
      const restored = await db.query<{ body: string }>(
        "SELECT pg_get_functiondef('private.admin_approve_invite_request(uuid)'::regprocedure) AS body"
      )
      expect(restored[0]?.body).toContain("dispatch_email_notification")
    } finally {
      await db.query(
        readFileSync(
          join(process.cwd(), "schema/migrations/20261008004000_transactional_invite_email.sql"),
          "utf8"
        )
      )
    }
  })
  it("denies direct anonymous/member access to private delivery payloads", async () => {
    await db.withTransaction(async (client) => {
      await client.query("SET LOCAL ROLE authenticated")
      await expect(
        client.query("SELECT * FROM private.transactional_email_outbox")
      ).rejects.toThrow(/permission denied/)
    })
  })
  it("keeps malformed provider acceptance pending and records permanent provider refusal honestly", async () => {
    await operator()
    await request(app.getHttpServer())
      .post("/v1/onboarding/requests")
      .send({ email: "invitee@example.com" })
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("refused", { status: 422 }))
    vi.stubGlobal("fetch", fetch)
    try {
      const worker = app.get(TransactionalEmailService)
      await worker.handleJob({ task: "process" })
      const rows = await admin("get", "/v1/admin/invite-deliveries")
      expect(rows.body[0]).toMatchObject({ status: "pending", attempts: 1 })
      await admin("post", `/v1/admin/invite-deliveries/${rows.body[0].id}/retry`)
      await worker.handleJob({ task: "process" })
      expect((await admin("get", "/v1/admin/invite-deliveries")).body[0]).toMatchObject({
        status: "failed",
        attempts: 2,
        last_error: "provider_422",
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it("keeps welcome template variable serialization identical across persisted retries", async () => {
    await operator()
    provider.users.getUser.mockResolvedValue(verifiedUser())
    await deliver("user.created")
    const bodies: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, input: RequestInit) => {
        bodies.push(String(input.body))
        return bodies.length === 1
          ? new Response("unavailable", { status: 503 })
          : new Response(JSON.stringify({ id: "welcome_retry" }), { status: 200 })
      })
    )
    try {
      const worker = app.get(TransactionalEmailService)
      await worker.handleJob({ task: "process" })
      const rows = await admin("get", "/v1/admin/invite-deliveries")
      await admin("post", `/v1/admin/invite-deliveries/${rows.body[0].id}/retry`)
      await worker.handleJob({ task: "process" })
      expect(bodies).toHaveLength(2)
      expect(bodies[1]).toBe(bodies[0])
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it("prevents an expired lease owner from overwriting a newer successful delivery", async () => {
    await operator()
    await request(app.getHttpServer())
      .post("/v1/onboarding/requests")
      .send({ email: "invitee@example.com" })
    let release!: () => void
    let started!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const providerFetch = vi.fn(async () => {
      if (providerFetch.mock.calls.length === 1) {
        started()
        await held
        return new Response("unavailable", { status: 503 })
      }
      return new Response(JSON.stringify({ id: "email_new_owner" }), { status: 200 })
    })
    vi.stubGlobal("fetch", providerFetch)
    const worker = app.get(TransactionalEmailService)
    try {
      const older = worker.handleJob({ task: "process" })
      await firstStarted
      await db.query(
        "UPDATE private.transactional_email_outbox SET locked_until=now()-interval '1 second'"
      )
      await worker.handleJob({ task: "process" })
      release()
      await older
      expect((await admin("get", "/v1/admin/invite-deliveries")).body[0]).toMatchObject({
        status: "sent",
        attempts: 2,
        last_error: null,
      })
    } finally {
      release()
      vi.unstubAllGlobals()
    }
  })
  it("allows only one approval and one invitation delivery under concurrent decisions", async () => {
    await operator()
    await request(app.getHttpServer())
      .post("/v1/onboarding/requests")
      .send({ email: "invitee@example.com" })
    const rows = await admin("get", "/v1/admin/invite-requests")
    const responses = await Promise.all([
      admin("post", `/v1/admin/invite-requests/${rows.body[0].id}/approve`),
      admin("post", `/v1/admin/invite-requests/${rows.body[0].id}/approve`),
    ])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 404])
    expect((await admin("get", "/v1/admin/invite-codes")).body).toHaveLength(1)
    expect(
      (await admin("get", "/v1/admin/invite-deliveries")).body.filter(
        (row: { kind: string }) => row.kind === "request_approved"
      )
    ).toHaveLength(1)
  })
  it("runs the installed queue handler through real PostgreSQL and controlled delivery", async () => {
    await operator()
    await request(app.getHttpServer())
      .post("/v1/onboarding/requests")
      .send({ email: "invitee@example.com" })
    const providerFetch = vi.fn(
      async () => new Response(JSON.stringify({ id: "email_queue" }), { status: 200 })
    )
    vi.stubGlobal("fetch", providerFetch)
    const config = app.get(ConfigService)
    const jobs = app.get(JobsService)
    config.set("NODE_ENV", "development")
    try {
      await jobs.onApplicationBootstrap()
      expect(await jobs.send("transactional-email", { task: "process" })).toBeTypeOf("string")
      await vi.waitFor(
        async () => {
          expect((await admin("get", "/v1/admin/invite-deliveries")).body[0]).toMatchObject({
            status: "sent",
            attempts: 1,
          })
        },
        { timeout: 10000, interval: 100 }
      )
      expect(providerFetch).toHaveBeenCalledOnce()
    } finally {
      await jobs.onApplicationShutdown()
      config.set("NODE_ENV", "test")
      vi.unstubAllGlobals()
    }
  })
  it("keeps approval and delivery enqueue atomic when audit persistence fails", async () => {
    await operator()
    await request(app.getHttpServer())
      .post("/v1/onboarding/requests")
      .send({ email: "invitee@example.com" })
    const rows = await admin("get", "/v1/admin/invite-requests")
    await db.query(`CREATE FUNCTION public.reject_invite_email_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture audit failure'; END $$;
   CREATE TRIGGER reject_invite_email_audit BEFORE INSERT ON public.admin_audit_log FOR EACH ROW EXECUTE FUNCTION public.reject_invite_email_audit()`)
    try {
      expect(
        (await admin("post", `/v1/admin/invite-requests/${rows.body[0].id}/approve`)).status
      ).toBe(503)
    } finally {
      await db.query(
        "DROP TRIGGER reject_invite_email_audit ON public.admin_audit_log; DROP FUNCTION public.reject_invite_email_audit()"
      )
    }
    expect((await admin("get", "/v1/admin/invite-requests")).body[0].status).toBe("pending")
    expect((await admin("get", "/v1/admin/invite-codes")).body).toHaveLength(0)
    expect(
      (await admin("get", "/v1/admin/invite-deliveries")).body.map(
        (row: { kind: string }) => row.kind
      )
    ).toEqual(["admin_request"])
  })
  it("keeps provisioning and welcome enqueue atomic when durable persistence fails", async () => {
    await operator()
    provider.users.getUser.mockResolvedValue(verifiedUser())
    await db.query(`CREATE FUNCTION private.reject_welcome_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='welcome' THEN RAISE EXCEPTION 'fixture outbox failure'; END IF; RETURN NEW; END $$;
   CREATE TRIGGER reject_welcome_outbox BEFORE INSERT ON private.transactional_email_outbox FOR EACH ROW EXECUTE FUNCTION private.reject_welcome_outbox()`)
    try {
      expect((await deliver("user.created")).status).toBe(503)
    } finally {
      await db.query(
        "DROP TRIGGER reject_welcome_outbox ON private.transactional_email_outbox; DROP FUNCTION private.reject_welcome_outbox()"
      )
    }
    expect(await identity.resolve("user_parent")).toBeNull()
    expect((await deliver("user.created")).status).toBe(200)
    expect((await admin("get", "/v1/admin/invite-deliveries")).body).toHaveLength(1)
  })
  it("recovers a lost database acknowledgment without changing the provider request", async () => {
    await operator()
    await request(app.getHttpServer())
      .post("/v1/onboarding/requests")
      .send({ email: "invitee@example.com" })
    const sends: Array<{ key: string | null; body: string }> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, input: RequestInit) => {
        sends.push({
          key: new Headers(input.headers).get("Idempotency-Key"),
          body: String(input.body),
        })
        return new Response(JSON.stringify({ id: "email_accepted" }), { status: 200 })
      })
    )
    await db.query(`CREATE FUNCTION private.fail_email_ack() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='sent' THEN RAISE EXCEPTION 'fixture acknowledgment failure'; END IF; RETURN NEW; END $$;
   CREATE TRIGGER fail_email_ack BEFORE UPDATE ON private.transactional_email_outbox FOR EACH ROW EXECUTE FUNCTION private.fail_email_ack()`)
    try {
      await expect(
        app.get(TransactionalEmailService).handleJob({ task: "process" })
      ).rejects.toThrow("fixture acknowledgment failure")
      expect((await admin("get", "/v1/admin/invite-deliveries")).body[0]).toMatchObject({
        status: "processing",
        attempts: 1,
      })
    } finally {
      await db.query(
        "DROP TRIGGER fail_email_ack ON private.transactional_email_outbox; DROP FUNCTION private.fail_email_ack()"
      )
    }
    try {
      await db.query(
        "UPDATE private.transactional_email_outbox SET locked_until=now()-interval '1 second'"
      )
      await app.get(TransactionalEmailService).handleJob({ task: "process" })
      expect(sends).toHaveLength(2)
      expect(sends[1]).toEqual(sends[0])
      expect((await admin("get", "/v1/admin/invite-deliveries")).body[0]).toMatchObject({
        status: "sent",
        attempts: 2,
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("does not report missing provider configuration as sent or consume the retry window", async () => {
    await operator()
    await request(app.getHttpServer())
      .post("/v1/onboarding/requests")
      .send({ email: "invitee@example.com" })
    const config = app.get(ConfigService)
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    config.set("RESEND_API_KEY", "")
    try {
      await app.get(TransactionalEmailService).handleJob({ task: "process" })
      const rows = await admin("get", "/v1/admin/invite-deliveries")
      expect(rows.body[0]).toMatchObject({
        status: "pending",
        attempts: 0,
        first_attempt_at: null,
        last_error: "provider_not_configured",
      })
      expect(fetch).not.toHaveBeenCalled()
      expect((await admin("get", "/v1/admin/invite-deliveries/status")).body).toMatchObject({
        provider_configured: false,
      })
    } finally {
      vi.unstubAllGlobals()
      config.set("RESEND_API_KEY", "re_fixture")
    }
  })
  it("keeps missing admin recipient pending and enforces production worker ownership", async () => {
    await operator()
    await request(app.getHttpServer())
      .post("/v1/onboarding/requests")
      .send({ email: "invitee@example.com" })
    const config = app.get(ConfigService)
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    try {
      config.set("ADMIN_NOTIFY_EMAIL", "")
      await app.get(TransactionalEmailService).handleJob({ task: "process" })
      expect((await admin("get", "/v1/admin/invite-deliveries")).body[0]).toMatchObject({
        status: "pending",
        attempts: 0,
        last_error: "recipient_not_configured",
      })
      config.set("NODE_ENV", "production")
      config.set("CUTOVER_NOTIFY", undefined)
      await expect(
        app.get(TransactionalEmailService).handleJob({ task: "process" })
      ).rejects.toThrow("ownership is disabled")
      expect((await admin("get", "/v1/admin/invite-deliveries/status")).body.worker_enabled).toBe(
        false
      )
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
      config.set("NODE_ENV", "test")
      config.set("ADMIN_NOTIFY_EMAIL", "operator@example.com")
    }
  })
  it("delivers rejection without exposing private reviewer notes", async () => {
    await operator()
    await request(app.getHttpServer())
      .post("/v1/onboarding/requests")
      .send({ email: "invitee@example.com", message: "<script>family</script>" })
    const rows = await admin("get", "/v1/admin/invite-requests")
    expect(
      (
        await admin("post", `/v1/admin/invite-requests/${rows.body[0].id}/reject`, {
          notes: "Private reviewer decision",
        })
      ).status
    ).toBe(200)
    const sends: Array<Record<string, unknown>> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, input: RequestInit) => {
        sends.push(JSON.parse(String(input.body)))
        return new Response(JSON.stringify({ id: "email_reject" }), { status: 200 })
      })
    )
    try {
      await app.get(TransactionalEmailService).handleJob({ task: "process" })
    } finally {
      vi.unstubAllGlobals()
    }
    const refusal = sends.find((send) => send.to === "invitee@example.com")!
    expect(refusal.subject).toBe("Update on your Family Events invite request")
    expect(String(refusal.html)).not.toContain("Private reviewer decision")
    const adminMail = sends.find((send) => send.to === "operator@example.com")!
    expect(String(adminMail.html)).toContain("&lt;script&gt;family&lt;/script&gt;")
  })
  it("stops expired uncertain attempts and refuses automatic or manual duplicate delivery", async () => {
    await operator()
    await request(app.getHttpServer())
      .post("/v1/onboarding/requests")
      .send({ email: "invitee@example.com" })
    const rows = await admin("get", "/v1/admin/invite-deliveries")
    await db.query(
      "UPDATE private.transactional_email_outbox SET first_attempt_at=now()-interval '24 hours',attempts=1 WHERE id=$1",
      [rows.body[0].id]
    )
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    try {
      expect(
        (await admin("post", `/v1/admin/invite-deliveries/${rows.body[0].id}/retry`)).status
      ).toBe(409)
      await app.get(TransactionalEmailService).handleJob({ task: "process" })
      expect((await admin("get", "/v1/admin/invite-deliveries")).body[0]).toMatchObject({
        status: "needs_review",
        last_error: "idempotency_window_expired",
      })
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it("cancels queued welcome when the identity has been deleted", async () => {
    await operator()
    provider.users.getUser.mockResolvedValue(verifiedUser())
    await deliver("user.created")
    expect((await deliver("user.deleted")).status).toBe(200)
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    try {
      await app.get(TransactionalEmailService).handleJob({ task: "process" })
      expect((await admin("get", "/v1/admin/invite-deliveries")).body[0]).toMatchObject({
        kind: "welcome",
        status: "cancelled",
        last_error: "account_deleted",
      })
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it("conceals delivery data and mutation from anonymous and member callers", async () => {
    await operator()
    provider.users.getUser.mockResolvedValue(verifiedUser())
    await deliver("user.created")
    const rows = await admin("get", "/v1/admin/invite-deliveries")
    expect((await request(app.getHttpServer()).get("/v1/admin/invite-deliveries")).status).toBe(401)
    expect(
      (
        await request(app.getHttpServer())
          .get("/v1/admin/invite-deliveries")
          .set("Authorization", "Bearer old-parent-token")
      ).status
    ).toBe(404)
    expect(
      (
        await request(app.getHttpServer())
          .post(`/v1/admin/invite-deliveries/${rows.body[0].id}/retry`)
          .set("Authorization", "Bearer old-parent-token")
          .send({})
      ).status
    ).toBe(404)
  })

  it("queues one welcome atomically with a new Clerk account across callback replays", async () => {
    await operator()
    provider.users.getUser.mockResolvedValue(verifiedUser())
    expect((await deliver("user.created")).status).toBe(200)
    expect((await deliver("user.created")).status).toBe(200)
    const rows = await admin("get", "/v1/admin/invite-deliveries")
    expect(rows.body).toHaveLength(1)
    expect(rows.body[0]).toMatchObject({ kind: "welcome", status: "pending" })
    const sends: Array<Record<string, unknown>> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, input: RequestInit) => {
        sends.push(JSON.parse(String(input.body)))
        return new Response(JSON.stringify({ id: "email_welcome" }), { status: 200 })
      })
    )
    try {
      await app.get(TransactionalEmailService).handleJob({ task: "process" })
    } finally {
      vi.unstubAllGlobals()
    }
    expect(sends).toEqual([
      {
        from: "Family Events <hello@example.com>",
        to: "parent@example.com",
        subject: "Welcome to Family Events",
        template: {
          id: "family-events-welcome",
          variables: { USERNAME: "Parent Family", APP_URL: "https://app.example.com" },
        },
      },
    ])
  })

  it("retries provider failure with the exact same request and provider key", async () => {
    await operator()
    await request(app.getHttpServer())
      .post("/v1/onboarding/requests")
      .send({ email: "invitee@example.com" })
    const sends: Array<{ key: string | null; body: string }> = []
    const worker = app.get(TransactionalEmailService)
    const providerFetch = vi.fn(async (_url: string, input: RequestInit) => {
      sends.push({
        key: new Headers(input.headers).get("Idempotency-Key"),
        body: String(input.body),
      })
      return sends.length === 1
        ? new Response("failure", { status: 503 })
        : new Response(JSON.stringify({ id: "email_retry" }), { status: 200 })
    })
    vi.stubGlobal("fetch", providerFetch)
    try {
      await worker.handleJob({ task: "process" })
      const pending = await admin("get", "/v1/admin/invite-deliveries")
      expect(pending.body[0]).toMatchObject({
        status: "pending",
        attempts: 1,
        last_error: "provider_503",
      })
      expect(
        (await admin("post", `/v1/admin/invite-deliveries/${pending.body[0].id}/retry`)).status
      ).toBe(200)
      app.get(ConfigService).set("APP_URL", "https://changed.example.com")
      await worker.handleJob({ task: "process" })
      expect(sends).toHaveLength(2)
      expect(sends[1]).toEqual(sends[0])
      expect((await admin("get", "/v1/admin/invite-deliveries")).body[0]).toMatchObject({
        status: "sent",
        attempts: 2,
      })
    } finally {
      vi.unstubAllGlobals()
      app.get(ConfigService).set("APP_URL", "https://app.example.com")
    }
  })

  it("delivers the approved invitation through the supported provider with a stable key", async () => {
    await operator()
    await request(app.getHttpServer())
      .post("/v1/onboarding/requests")
      .send({ email: "invitee@example.com" })
    const rows = await admin("get", "/v1/admin/invite-requests")
    const approval = await admin("post", `/v1/admin/invite-requests/${rows.body[0].id}/approve`)
    const sends: Array<{ key: string | null; body: Record<string, unknown> }> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, input: RequestInit) => {
        sends.push({
          key: new Headers(input.headers).get("Idempotency-Key"),
          body: JSON.parse(String(input.body)),
        })
        return new Response(JSON.stringify({ id: `email_${sends.length}` }), { status: 200 })
      })
    )
    try {
      await app.get(TransactionalEmailService).handleJob({ task: "process" })
    } finally {
      vi.unstubAllGlobals()
    }
    expect(sends).toHaveLength(2)
    const invite = sends.find((send) => send.body.to === "invitee@example.com")!
    expect(invite.key).toMatch(/^family-events-transactional-/)
    expect(invite.body.html).toContain(approval.body.code)
    expect(invite.body.html).toContain("https://app.example.com/onboarding")
    const deliveries = await admin("get", "/v1/admin/invite-deliveries")
    expect(deliveries.body.every((row: { status: string }) => row.status === "sent")).toBe(true)
    expect(
      await db.query("SELECT payload,delivery FROM private.transactional_email_outbox")
    ).toEqual([
      { payload: null, delivery: null },
      { payload: null, delivery: null },
    ])
  })

  it("approves a request durably without calling the legacy email dispatcher", async () => {
    await operator()
    const response = await request(app.getHttpServer())
      .post("/v1/onboarding/requests")
      .send({ email: "invitee@example.com", message: "Our family" })
    expect(response.status).toBe(200)
    const requests = await admin("get", "/v1/admin/invite-requests")
    expect(requests.body).toHaveLength(1)
    const approval = await admin("post", `/v1/admin/invite-requests/${requests.body[0].id}/approve`)
    expect(approval.status).toBe(200)
    const deliveries = await admin("get", "/v1/admin/invite-deliveries")
    expect(deliveries.status).toBe(200)
    expect(deliveries.body.map((row: { kind: string }) => row.kind).sort()).toEqual([
      "admin_request",
      "request_approved",
    ])
    expect(JSON.stringify(deliveries.body)).not.toContain(approval.body.code)
  })
})
