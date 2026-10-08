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
    "TRUNCATE private.clerk_user_lifecycle, auth.users, public.clerk_user_mapping, public.pending_invite_claims, private.transactional_email_outbox CASCADE"
  )
})

describe("Clerk lifecycle HTTP", () => {
  it("binds the verified primary email to its confirmed historical UUID without changing ownership or settings", async () => {
    const uuid = randomUUID()
    await db.query("INSERT INTO auth.users(id,email,email_confirmed_at) VALUES ($1,$2,now())", [
      uuid,
      "parent@example.com",
    ])
    await db.query(
      "UPDATE public.user_profiles SET display_name='My chosen name',child_age=7,role='admin' WHERE id=$1",
      [uuid]
    )
    await db.query("UPDATE public.user_access SET is_enabled=true WHERE user_id=$1", [uuid])
    provider.users.getUser.mockResolvedValue(verifiedUser())
    expect((await deliver("user.created")).status).toBe(200)
    expect(await identity.resolve("user_parent")).toEqual({
      clerkUserId: "user_parent",
      supabaseUuid: uuid,
      email: "parent@example.com",
      role: "operator",
    })
    expect(
      await db.query("SELECT display_name,child_age FROM public.user_profiles WHERE id = $1", [
        uuid,
      ])
    ).toEqual([{ display_name: "My chosen name", child_age: 7 }])
  })

  it("provisions an open-registration member once even with duplicate deliveries and provider operator metadata", async () => {
    provider.users.getUser.mockResolvedValue(verifiedUser())
    expect((await deliver("user.created")).status).toBe(200)
    const original = await identity.resolve("user_parent")
    expect(original).toMatchObject({ email: "parent@example.com", role: "member" })
    expect((await deliver("user.created")).status).toBe(200)
    expect(await identity.resolve("user_parent")).toEqual(original)
    expect(
      await db.query("SELECT is_enabled FROM public.user_access WHERE user_id=$1", [
        original!.supabaseUuid,
      ])
    ).toEqual([{ is_enabled: true }])
    expect(await db.query("SELECT id FROM auth.users")).toHaveLength(1)
  })

  it("claims a live invitation atomically during invite-only signup and leaves uninvited access disabled", async () => {
    await db.query("UPDATE private.clerk_lifecycle_policy_fixture SET require_invite=true")
    await db.query(
      "INSERT INTO public.pending_invite_claims(email,invite_code,expires_at) VALUES('parent@example.com','fixture',now()+interval '1 hour')"
    )
    provider.users.getUser.mockResolvedValue(verifiedUser())
    const deliveries = await Promise.all([deliver("user.created"), deliver("user.updated")])
    expect(deliveries.map((response) => response.status)).toEqual([200, 200])
    const invited = await identity.resolve("user_parent")
    expect(
      await db.query("SELECT is_enabled FROM public.user_access WHERE user_id=$1", [
        invited!.supabaseUuid,
      ])
    ).toEqual([{ is_enabled: true }])
    expect(await db.query("SELECT claimed_by FROM public.pending_invite_claims")).toEqual([
      { claimed_by: invited!.supabaseUuid },
    ])
    provider.users.getUser.mockResolvedValue(
      verifiedUser("user_uninvited", "uninvited@example.com")
    )
    expect((await deliver("user.created", "user_uninvited")).status).toBe(200)
    const uninvited = await identity.resolve("user_uninvited")
    expect(
      await db.query("SELECT is_enabled FROM public.user_access WHERE user_id=$1", [
        uninvited!.supabaseUuid,
      ])
    ).toEqual([{ is_enabled: false }])
  })

  it("cleans up a deleted account, retains an audit snapshot, and never revives access on callback retries", async () => {
    provider.users.getUser.mockResolvedValue(verifiedUser())
    expect((await deliver("user.created")).status).toBe(200)
    const mapped = await identity.resolve("user_parent")
    expect((await deliver("user.deleted")).status).toBe(200)
    expect(await identity.resolve("user_parent")).toBeNull()
    expect(
      await db.query("SELECT id FROM public.user_profiles WHERE id=$1", [mapped!.supabaseUuid])
    ).toEqual([])
    expect(
      await db.query("SELECT user_id FROM public.user_access WHERE user_id=$1", [
        mapped!.supabaseUuid,
      ])
    ).toEqual([])
    expect((await deliver("user.deleted")).status).toBe(200)
    expect((await deliver("user.updated")).status).toBe(200)
    expect((await deliver("user.created")).status).toBe(200)
    expect(await identity.resolve("user_parent")).toBeNull()
    const audits = await db.query<{ action: string; metadata: Record<string, unknown> }>(
      "SELECT action,metadata FROM public.admin_audit_log WHERE target_id=$1",
      [mapped!.supabaseUuid]
    )
    expect(audits).toEqual([
      {
        action: "user.delete",
        metadata: expect.objectContaining({
          source: "clerk",
          previous_profile: expect.objectContaining({ email: "parent@example.com" }),
        }),
      },
    ])
  })

  it("keeps the mapped UUID and local preferences on email updates, ignores stale snapshots, and preserves disabled expired access", async () => {
    provider.users.getUser.mockResolvedValue(verifiedUser())
    await deliver("user.created")
    const original = await identity.resolve("user_parent")
    await db.query(
      "UPDATE public.user_profiles SET display_name='Chosen',child_age=9 WHERE id=$1",
      [original!.supabaseUuid]
    )
    await db.query(
      "UPDATE public.user_access SET is_enabled=false,access_expires_at='2026-01-01',disabled_reason='operator decision' WHERE user_id=$1",
      [original!.supabaseUuid]
    )
    provider.users.getUser.mockResolvedValue(verifiedUser("user_parent", "new@example.com", 3000))
    expect((await deliver("user.updated")).status).toBe(200)
    expect(await identity.resolve("user_parent")).toMatchObject({
      supabaseUuid: original!.supabaseUuid,
      email: "new@example.com",
      role: "member",
    })
    provider.users.getUser.mockResolvedValue(verifiedUser("user_parent", "stale@example.com", 2000))
    expect((await deliver("user.updated")).status).toBe(200)
    expect(await identity.resolve("user_parent")).toMatchObject({ email: "new@example.com" })
    expect(
      await db.query("SELECT display_name,child_age FROM public.user_profiles WHERE id=$1", [
        original!.supabaseUuid,
      ])
    ).toEqual([{ display_name: "Chosen", child_age: 9 }])
    expect(
      await db.query("SELECT is_enabled,disabled_reason FROM public.user_access WHERE user_id=$1", [
        original!.supabaseUuid,
      ])
    ).toEqual([{ is_enabled: false, disabled_reason: "operator decision" }])
  })

  it("treats provider-not-found as deletion when an update arrives after the account is gone", async () => {
    provider.users.getUser.mockResolvedValue(verifiedUser())
    await deliver("user.created")
    provider.users.getUser.mockRejectedValue({ status: 404 })
    expect((await deliver("user.updated")).status).toBe(200)
    expect(await identity.resolve("user_parent")).toBeNull()
    provider.users.getUser.mockResolvedValue(verifiedUser())
    await deliver("user.created")
    expect(await identity.resolve("user_parent")).toBeNull()
  })

  it("serializes conflicting Clerk accounts for the same verified email without splitting legacy data", async () => {
    provider.users.getUser.mockImplementation(async (id: string) => verifiedUser(id))
    const outcomes = await Promise.all([
      deliver("user.created", "user_one"),
      deliver("user.created", "user_two"),
    ])
    expect(outcomes.map((response) => response.status).toSorted()).toEqual([200, 409])
    expect(await db.query("SELECT id FROM auth.users")).toHaveLength(1)
    expect(await db.query("SELECT supabase_uuid FROM public.clerk_user_mapping")).toHaveLength(1)
  })

  it("does not bind an unconfirmed historical email or trust an unverified primary email", async () => {
    const uuid = randomUUID()
    await db.query("INSERT INTO auth.users(id,email) VALUES($1,'parent@example.com')", [uuid])
    provider.users.getUser.mockResolvedValue(verifiedUser())
    expect((await deliver("user.created")).status).toBe(409)
    expect(await identity.resolve("user_parent")).toBeNull()
    const unverified = verifiedUser("user_unverified", "other@example.com")
    unverified.emailAddresses[0]!.verification.status = "unverified"
    provider.users.getUser.mockResolvedValue(unverified)
    expect((await deliver("user.created", "user_unverified")).status).toBe(200)
    expect(await identity.resolve("user_unverified")).toBeNull()
    expect(await db.query("SELECT id FROM auth.users")).toEqual([{ id: uuid }])
  })

  it("retains a tombstone when deletion arrives before signup or through the existing admin database cascade", async () => {
    expect((await deliver("user.deleted")).status).toBe(200)
    provider.users.getUser.mockResolvedValue(verifiedUser())
    expect((await deliver("user.created")).status).toBe(200)
    expect(await identity.resolve("user_parent")).toBeNull()
    provider.users.getUser.mockResolvedValue(verifiedUser("user_other", "other@example.com"))
    await deliver("user.created", "user_other")
    const mapped = await identity.resolve("user_other")
    await db.query("DELETE FROM auth.users WHERE id=$1", [mapped!.supabaseUuid])
    await deliver("user.updated", "user_other")
    expect(await identity.resolve("user_other")).toBeNull()
    expect(await db.query("SELECT id FROM auth.users")).toEqual([])
  })

  it("returns a retryable provider failure without changing ownership", async () => {
    provider.users.getUser.mockRejectedValue({ status: 503 })
    expect((await deliver("user.created")).status).toBe(503)
    expect(await identity.resolve("user_parent")).toBeNull()
    provider.users.getUser.mockResolvedValue(verifiedUser())
    expect((await deliver("user.created")).status).toBe(200)
    expect(await identity.resolve("user_parent")).not.toBeNull()
  })

  it("revokes an attributed operator immediately while retaining the historical UUID and evidence", async () => {
    provider.users.getUser.mockResolvedValue(verifiedUser())
    await deliver("user.created")
    const mapped = await identity.resolve("user_parent")
    await db.query(
      "CREATE TABLE private.clerk_attribution_fixture(user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT)"
    )
    await db.query("INSERT INTO private.clerk_attribution_fixture VALUES($1)", [
      mapped!.supabaseUuid,
    ])
    try {
      await db.query("UPDATE public.user_profiles SET role='admin' WHERE id=$1", [
        mapped!.supabaseUuid,
      ])
      await db.query(
        "UPDATE public.clerk_user_mapping SET role='operator' WHERE clerk_user_id='user_parent'"
      )
      expect(
        (
          await request(app.getHttpServer())
            .get("/v1/admin/users")
            .set("Authorization", "Bearer old-parent-token")
        ).status
      ).toBe(200)
      expect((await deliver("user.deleted")).status).toBe(200)
      expect(await identity.resolve("user_parent")).toBeNull()
      expect(
        (
          await request(app.getHttpServer())
            .get("/v1/admin/users")
            .set("Authorization", "Bearer old-parent-token")
        ).status
      ).toBe(403)
      expect(
        await db.query("SELECT id FROM auth.users WHERE id=$1", [mapped!.supabaseUuid])
      ).toEqual([{ id: mapped!.supabaseUuid }])
      expect(
        await db.query("SELECT is_enabled FROM public.user_access WHERE user_id=$1", [
          mapped!.supabaseUuid,
        ])
      ).toEqual([{ is_enabled: false }])
      expect(await db.query("SELECT user_id FROM private.clerk_attribution_fixture")).toEqual([
        { user_id: mapped!.supabaseUuid },
      ])
      expect((await deliver("user.updated")).status).toBe(200)
      expect((await deliver("user.deleted")).status).toBe(200)
      expect(await identity.resolve("user_parent")).toBeNull()
      provider.users.getUser.mockResolvedValue(
        verifiedUser("user_replacement", "parent@example.com")
      )
      expect((await deliver("user.created", "user_replacement")).status).toBe(409)
      expect(await identity.resolve("user_replacement")).toBeNull()
      expect(
        await db.query("SELECT metadata FROM public.admin_audit_log WHERE target_id=$1", [
          mapped!.supabaseUuid,
        ])
      ).toEqual([
        { metadata: expect.objectContaining({ cleanup_deferred: true, source: "clerk" }) },
      ])
    } finally {
      await db.query("DROP TABLE private.clerk_attribution_fixture")
    }
  })

  it("rejects expired signatures, missing headers and malformed signed lifecycle identities", async () => {
    expect((await deliver("user.created", "user_parent", { "svix-timestamp": "1" })).status).toBe(
      400
    )
    expect(
      (await request(app.getHttpServer()).post("/webhooks/clerk").send({ type: "user.created" }))
        .status
    ).toBe(400)
    expect((await deliver("user.created", "invalid-id")).status).toBe(400)
    expect(await db.query("SELECT id FROM auth.users")).toEqual([])
  })

  it("rolls the additive schema back without altering existing UUID ownership", async () => {
    provider.users.getUser.mockResolvedValue(verifiedUser())
    await deliver("user.created")
    const mapped = await identity.resolve("user_parent")
    await db.query(
      readFileSync(join(process.cwd(), "schema/migrations", `${MIGRATION}_down.sql`), "utf8")
    )
    expect(await identity.resolve("user_parent")).toEqual(mapped)
    await db.query(
      readFileSync(join(process.cwd(), "schema/migrations", `${MIGRATION}.sql`), "utf8")
    )
    expect(await identity.resolve("user_parent")).toEqual(mapped)
  })

  it("does not recreate an account when a database deletion races a newer lifecycle snapshot", async () => {
    provider.users.getUser.mockResolvedValue(verifiedUser())
    await deliver("user.created")
    const mapped = await identity.resolve("user_parent")
    provider.users.getUser.mockResolvedValue(
      verifiedUser("user_parent", "parent@example.com", 5000)
    )
    const client = await db.pool.connect()
    try {
      await client.query("BEGIN")
      await client.query("DELETE FROM auth.users WHERE id=$1", [mapped!.supabaseUuid])
      const blocker = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
        .rows[0]!.pid
      const delivery = deliver("user.updated").then((response) => response)
      const deadline = Date.now() + 2000
      while (
        !(
          await db.query<{ blocked: boolean }>(
            "SELECT EXISTS(SELECT FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked",
            [blocker]
          )
        )[0]!.blocked
      ) {
        if (Date.now() > deadline)
          throw new Error("lifecycle request did not overlap the deletion transaction")
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      await client.query("COMMIT")
      expect((await delivery).status).toBe(200)
      expect(await identity.resolve("user_parent")).toBeNull()
    } finally {
      await client.query("ROLLBACK")
      client.release()
    }
  })

  it("rejects a tampered signed delivery before fetching the provider or provisioning", async () => {
    expect(
      (await deliver("user.created", "user_parent", { "svix-signature": "v1,bad" })).status
    ).toBe(400)
    expect(provider.users.getUser).not.toHaveBeenCalled()
  })
})
