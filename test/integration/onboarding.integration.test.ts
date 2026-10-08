import { UserAccessModule } from "../../src/user-access/user-access.module.js"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createHmac, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { type INestApplication } from "@nestjs/common"
import { ConfigModule } from "@nestjs/config"
import { Test } from "@nestjs/testing"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { AdminUserController } from "../../src/admin/admin-user.controller.js"
import { AdminUserRepository } from "../../src/admin/admin-user.repository.js"
import { AdminUserService } from "../../src/admin/admin-user.service.js"

import { OnboardingModule } from "../../src/onboarding/onboarding.module.js"

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
    if (token === "other-parent-token") return { sub: "user_other" }
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
            CLERK_SECRET_KEY: "sk_test_fixture",
            CLERK_WEBHOOK_SIGNING_SECRET: SIGNING_SECRET,
          }),
        ],
      }),
      DbModule,
      AuthModule,
      UserAccessModule,
      OnboardingModule,
    ],
    controllers: [AdminUserController],
    providers: [AdminUserRepository, AdminUserService],
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
  await db.query("DROP TABLE IF EXISTS private.account_deletions")
  await db.query(
    readFileSync(
      join(process.cwd(), "schema/migrations/20261008006000_coordinated_account_deletion.sql"),
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

async function enroll(id = "user_parent", email = "parent@example.com") {
  await db.query("UPDATE private.clerk_lifecycle_policy_fixture SET require_invite=true")
  provider.users.getUser.mockResolvedValue(verifiedUser(id, email))
  expect((await deliver("user.created", id)).status).toBe(200)
  return (await identity.resolve(id))!.supabaseUuid
}
function redeem(code = "ABC234", token = "old-parent-token", extra = {}) {
  return request(app.getHttpServer())
    .post("/v1/onboarding/redeem")
    .set("Authorization", `Bearer ${token}`)
    .send({ code, ...extra })
}
describe("Invitation onboarding HTTP", () => {
  it("keeps deleted identities revoked on enrollment and code retries", async () => {
    await enroll()
    await deliver("user.deleted")
    expect(
      (
        await request(app.getHttpServer())
          .get("/v1/onboarding/me")
          .set("Authorization", "Bearer old-parent-token")
      ).body
    ).toEqual({ state: "access_unavailable", required: true })
    expect((await redeem()).status).toBe(403)
  })
  it.each([
    { email: "invalid" },
    { email: "parent@example.com", message: "x".repeat(501) },
    { email: "parent@example.com", reviewed_by: randomUUID() },
  ])("rejects invalid or privileged public request fields", async (body) => {
    expect(
      (await request(app.getHttpServer()).post("/v1/onboarding/requests").send(body)).status
    ).toBe(400)
    expect(await db.query("SELECT email FROM public.invite_requests")).toHaveLength(0)
  })

  if (process.env.ONBOARDING_BROWSER_APP_DIR) {
    it("persists a browser invitation request through the app and API without sending email", async () => {
      await db.query("UPDATE private.clerk_lifecycle_policy_fixture SET require_invite=true")
      await app.listen(0, "127.0.0.1")
      try {
        const result = await promisify(execFile)(
          "corepack",
          ["pnpm", "exec", "playwright", "test", "e2e/onboarding.spec.ts", "--project=shell"],
          {
            cwd: process.env.ONBOARDING_BROWSER_APP_DIR,
            env: {
              ...process.env,
              DATABASE_URL: "",
              CLERK_SECRET_KEY: "",
              VITE_CLERK_PUBLISHABLE_KEY: "",
              API_URL: await app.getUrl(),
              PORT: "4509",
              ONBOARDING_INTEGRATION: "true",
            },
            timeout: 90000,
            maxBuffer: 1024 * 1024,
          }
        )
        expect(result.stdout).toContain("2 passed")
        expect(await db.query("SELECT email,message FROM public.invite_requests")).toEqual([
          { email: "browser-parent@example.com", message: "Weekend outings with children" },
        ])
      } catch (error) {
        if (error && typeof error === "object" && "stdout" in error) console.error(error.stdout)
        throw error
      }
    }, 100000)
  }

  it("limits concurrent redemption to one account and one code use", async () => {
    const a = await enroll()
    const b = await enroll("user_other", "other@example.com")
    await db.query(
      "INSERT INTO public.invite_codes(code_hash,max_uses) VALUES(private.hash_invite_code('ABC234'),1)"
    )
    const results = await Promise.all([redeem(), redeem("ABC234", "other-parent-token")])
    expect(results.map((r) => r.status).toSorted()).toEqual([200, 400])
    expect(await db.query("SELECT used_count FROM public.invite_codes")).toEqual([
      { used_count: 1 },
    ])
    expect(
      [await identity.hasEnabledAccess(a), await identity.hasEnabledAccess(b)].filter(Boolean)
    ).toHaveLength(1)
  })
  it("replays parallel redemption for the same account without consuming twice", async () => {
    await enroll()
    await db.query(
      "INSERT INTO public.invite_codes(code_hash,max_uses) VALUES(private.hash_invite_code('ABC234'),3)"
    )
    expect((await Promise.all([redeem(), redeem(), redeem()])).map((r) => r.status)).toEqual([
      200, 200, 200,
    ])
    expect(await db.query("SELECT used_count FROM public.invite_codes")).toEqual([
      { used_count: 1 },
    ])
    expect(
      await db.query(
        "SELECT count(*)::int AS n FROM public.admin_audit_log WHERE action='user.invite_redeem'"
      )
    ).toEqual([{ n: 1 }])
  })
  it.each(["invalid", "expired", "exhausted", "revoked"])(
    "rejects a %s invitation without enabling access",
    async (mode) => {
      const uuid = await enroll()
      if (mode !== "invalid")
        await db.query(
          `INSERT INTO public.invite_codes(code_hash,max_uses,used_count,expires_at,revoked_at)
    VALUES(private.hash_invite_code('ABC234'),1,$1,$2,$3)`,
          [
            mode === "exhausted" ? 1 : 0,
            mode === "expired" ? "2020-01-01" : null,
            mode === "revoked" ? "2020-01-01" : null,
          ]
        )
      expect((await redeem()).status).toBe(400)
      expect(await identity.hasEnabledAccess(uuid)).toBe(false)
      expect(await db.query("SELECT email FROM public.pending_invite_claims")).toHaveLength(0)
    }
  )
  it.each(["disabled", "expired", "claimed"])(
    "does not revive a %s account with another code",
    async (mode) => {
      const uuid = await enroll()
      await db.query(
        "INSERT INTO public.invite_codes(code_hash,max_uses) VALUES(private.hash_invite_code('ABC234'),3)"
      )
      if (mode === "disabled")
        await db.query(
          "UPDATE public.user_access SET disabled_at=now(),disabled_reason='operator decision' WHERE user_id=$1",
          [uuid]
        )
      if (mode === "expired")
        await db.query(
          "UPDATE public.user_access SET is_enabled=true,access_expires_at=now()-interval '1 second' WHERE user_id=$1",
          [uuid]
        )
      if (mode === "claimed")
        await db.query(
          "INSERT INTO public.pending_invite_claims(email,invite_code,expires_at,claimed_by,claimed_at) VALUES('parent@example.com',private.hash_invite_code('OLD'),now()+interval '1 hour',$1,now())",
          [uuid]
        )
      expect((await redeem()).status).toBe(403)
      expect(await identity.hasEnabledAccess(uuid)).toBe(false)
      expect(await db.query("SELECT used_count FROM public.invite_codes")).toEqual([
        { used_count: 0 },
      ])
    }
  )
  it("fails visibly while provisioning is unavailable without reserving an invitation", async () => {
    provider.users.getUser.mockRejectedValue(new Error("fixture offline"))
    expect((await deliver("user.created")).status).toBe(503)
    const response = await redeem()
    expect(response.status).toBe(409)
    expect(response.body.message).toContain("provisioned")
    expect(await db.query("SELECT email FROM public.pending_invite_claims")).toHaveLength(0)
  })
  it("does not accept caller-selected identity or unauthenticated redemption", async () => {
    await enroll()
    expect(
      (await redeem("ABC234", "old-parent-token", { email: "other@example.com" })).status
    ).toBe(400)
    expect((await redeem("ABC234", "forged")).status).toBe(401)
    expect((await request(app.getHttpServer()).get("/v1/onboarding/me")).status).toBe(401)
  })
  it("rate limits failed code attempts and public requests under concurrent calls", async () => {
    await enroll()
    await Promise.all(Array.from({ length: 8 }, () => redeem("WRONG")))
    expect(
      await db.query("SELECT count(*)::int AS n FROM public.invite_redemption_attempts")
    ).toEqual([{ n: 5 }])
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        request(app.getHttpServer())
          .post("/v1/onboarding/requests")
          .send({ email: "parent@example.com", message: "request" })
      )
    )
    expect(results.every((r) => r.status === 200 && r.body.received === true)).toBe(true)
    expect(await db.query("SELECT count(*)::int AS n FROM public.invite_request_attempts")).toEqual(
      [{ n: 3 }]
    )
    expect(await db.query("SELECT count(*)::int AS n FROM public.invite_requests")).toEqual([
      { n: 1 },
    ])
  })
  it("rolls back a claimed code and access when durable audit fails", async () => {
    const uuid = await enroll()
    await db.query(
      "INSERT INTO public.invite_codes(code_hash,max_uses) VALUES(private.hash_invite_code('ABC234'),1)"
    )
    await db.query(`CREATE FUNCTION public.reject_onboarding_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit fixture'; END $$;
    CREATE TRIGGER reject_onboarding_audit BEFORE INSERT ON public.admin_audit_log FOR EACH ROW EXECUTE FUNCTION public.reject_onboarding_audit()`)
    try {
      expect((await redeem()).status).toBe(503)
    } finally {
      await db.query(
        "DROP TRIGGER reject_onboarding_audit ON public.admin_audit_log; DROP FUNCTION public.reject_onboarding_audit()"
      )
    }
    expect(await identity.hasEnabledAccess(uuid)).toBe(false)
    expect(await db.query("SELECT used_count FROM public.invite_codes")).toEqual([
      { used_count: 0 },
    ])
    expect((await redeem()).status).toBe(200)
  })

  it("redeems once for the mapped member and retains UUID ownership", async () => {
    await db.query("UPDATE private.clerk_lifecycle_policy_fixture SET require_invite=true")
    provider.users.getUser.mockResolvedValue(verifiedUser())
    await deliver("user.created")
    const original = await identity.resolve("user_parent")
    await db.query(
      "INSERT INTO public.invite_codes(code_hash,max_uses) VALUES(private.hash_invite_code('ABC234'),1)"
    )
    const redeemOwnAccount = () =>
      request(app.getHttpServer())
        .post("/v1/onboarding/redeem")
        .set("Authorization", "Bearer old-parent-token")
        .send({ code: "abc-234" })
    const response = await redeemOwnAccount()
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ state: "ready", required: true })
    expect((await redeemOwnAccount()).body).toEqual({ state: "ready", required: true })
    expect(await identity.resolve("user_parent")).toEqual(original)
    expect(await identity.hasEnabledAccess(original!.supabaseUuid)).toBe(true)
    expect(await db.query("SELECT used_count FROM public.invite_codes")).toEqual([
      { used_count: 1 },
    ])
    expect(await db.query("SELECT claimed_by FROM public.pending_invite_claims")).toEqual([
      { claimed_by: original!.supabaseUuid },
    ])
  })

  it("accepts a public request idempotently without exposing reviewer data", async () => {
    const response = await request(app.getHttpServer())
      .post("/v1/onboarding/requests")
      .send({ email: " Parent@Example.com ", message: "We have two children" })
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ received: true })
    await db.query("UPDATE public.invite_requests SET admin_notes='private decision'")
    expect(
      (
        await request(app.getHttpServer())
          .post("/v1/onboarding/requests")
          .send({ email: "parent@example.com" })
      ).body
    ).toEqual({ received: true })
    expect(await db.query("SELECT email,message FROM public.invite_requests")).toEqual([
      { email: "parent@example.com", message: "We have two children" },
    ])
  })

  it("reports provisioning pending and blocks uninvited personal access", async () => {
    const before = await request(app.getHttpServer())
      .get("/v1/onboarding/me")
      .set("Authorization", "Bearer old-parent-token")
    expect(before.status).toBe(200)
    expect(before.body).toEqual({ state: "provisioning_pending", required: false })
    await db.query("UPDATE private.clerk_lifecycle_policy_fixture SET require_invite=true")
    provider.users.getUser.mockResolvedValue(verifiedUser())
    expect((await deliver("user.created")).status).toBe(200)
    const response = await request(app.getHttpServer())
      .get("/v1/onboarding/me")
      .set("Authorization", "Bearer old-parent-token")
    expect(response.body).toEqual({ state: "invite_required", required: true })
    expect(
      (
        await request(app.getHttpServer())
          .get("/v1/admin/users")
          .set("Authorization", "Bearer old-parent-token")
      ).status
    ).toBe(403)
  })

  it("exposes only the effective invitation policy publicly", async () => {
    expect((await request(app.getHttpServer()).get("/v1/onboarding")).body).toEqual({
      required: false,
    })
    await db.query("UPDATE private.clerk_lifecycle_policy_fixture SET require_invite=true")
    expect((await request(app.getHttpServer()).get("/v1/onboarding")).body).toEqual({
      required: true,
    })
  })
})
