import { UserAccessModule } from "../../src/user-access/user-access.module.js"
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

import { JobsModule } from "../../src/jobs/jobs.module.js"

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
      UserAccessModule,
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
  await db.query("DROP TABLE IF EXISTS private.account_deletions")
  await db.query("DROP TABLE IF EXISTS private.transactional_email_outbox")
  await db.query(
    readFileSync(
      join(process.cwd(), "schema/migrations/20261008004000_transactional_invite_email.sql"),
      "utf8"
    )
  )
  await db.query(`CREATE TABLE IF NOT EXISTS public.recommendation_signals (
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
   event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,signal_type text NOT NULL,
   weight numeric(4,2) NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now());
   CREATE TABLE IF NOT EXISTS public.notification_queue(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,change_type text NOT NULL,change_detail jsonb DEFAULT '{}',processed boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),processed_at timestamptz);
   CREATE TABLE IF NOT EXISTS public.user_notifications(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,type text NOT NULL,title text NOT NULL,body text NOT NULL,event_id uuid REFERENCES public.events(id) ON DELETE SET NULL,read_at timestamptz,created_at timestamptz NOT NULL DEFAULT now());
   CREATE TABLE IF NOT EXISTS public.user_notification_preferences(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,reminder_email boolean NOT NULL DEFAULT true,reminder_push boolean NOT NULL DEFAULT true,change_email boolean NOT NULL DEFAULT true,change_push boolean NOT NULL DEFAULT true,digest_email boolean NOT NULL DEFAULT true,digest_push boolean NOT NULL DEFAULT false,digest_telegram boolean NOT NULL DEFAULT false,telegram_chat_id text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
   CREATE TABLE IF NOT EXISTS public.push_subscriptions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,platform text NOT NULL,endpoint text,token text,p256dh text,auth_key text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
   ALTER TABLE public.favorites ADD CONSTRAINT favorites_user_id_fkey FOREIGN KEY(user_id) REFERENCES public.user_profiles(id) ON DELETE CASCADE;
   ALTER TABLE public.user_calendar_events ADD CONSTRAINT user_calendar_events_user_id_fkey FOREIGN KEY(user_id) REFERENCES public.user_profiles(id) ON DELETE CASCADE;
   ALTER TABLE public.ratings ADD CONSTRAINT ratings_user_id_fkey FOREIGN KEY(user_id) REFERENCES public.user_profiles(id) ON DELETE CASCADE;`)
  await db.query(
    readFileSync(
      join(process.cwd(), "schema/migrations/20261008006000_coordinated_account_deletion.sql"),
      "utf8"
    )
  )
  await db.query("DROP TABLE IF EXISTS private.operator_presence")
  await db.query(
    readFileSync(
      join(process.cwd(), "schema/migrations/20261008007000_operator_presence.sql"),
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
  await db.query("TRUNCATE private.account_deletions")
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
  const agent = request(app.getHttpServer())
  return agent[method](path).set("Authorization", "Bearer operator-token").send(body)
}
describe("Coordinated account deletion HTTP", () => {
  it.each(["user.deleted", "provider404", "prior_tombstone"])(
    "cleans retained personal rows after %s and exposes an idempotent provider-free operator retry",
    async (kind) => {
      await operator()
      const other = await identity.resolve("user_operator")
      provider.users.getUser.mockResolvedValue(verifiedUser())
      await deliver("user.created")
      const member = await identity.resolve("user_parent")
      const eventId = randomUUID()
      await db.query(
        "CREATE TABLE private.callback_evidence_fixture(resolved_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT)"
      )
      await db.query("INSERT INTO private.callback_evidence_fixture VALUES($1)", [
        member!.supabaseUuid,
      ])
      await db.query(
        "INSERT INTO public.events(id,title,start_datetime) VALUES($1,'Retained callback fixture',now())",
        [eventId]
      )
      await db.query("INSERT INTO public.favorites(user_id,event_id) VALUES($1,$3),($2,$3)", [
        member!.supabaseUuid,
        other!.supabaseUuid,
        eventId,
      ])
      await db.query(
        "INSERT INTO public.comments(user_id,event_id,body) VALUES($1,$3,'Parent note'),($2,$3,'Other note')",
        [member!.supabaseUuid, other!.supabaseUuid, eventId]
      )
      await db.query("INSERT INTO private.operator_presence(user_id) VALUES($1),($2)", [
        member!.supabaseUuid,
        other!.supabaseUuid,
      ])
      await db.query("UPDATE public.user_profiles SET child_name='Child',child_age=4 WHERE id=$1", [
        member!.supabaseUuid,
      ])
      const fetch = vi.fn()
      vi.stubGlobal("fetch", fetch)
      try {
        if (kind === "provider404") provider.users.getUser.mockRejectedValue({ status: 404 })
        if (kind === "prior_tombstone") {
          await db.query(
            "UPDATE private.clerk_user_lifecycle SET deleted_at=now() WHERE clerk_user_id='user_parent'"
          )
          await db.query("DELETE FROM public.clerk_user_mapping WHERE clerk_user_id='user_parent'")
          await db.query(
            "INSERT INTO public.admin_audit_log(action,target_type,target_id,metadata) VALUES('user.delete','user_access',$1,$2::jsonb)",
            [
              member!.supabaseUuid,
              JSON.stringify({
                source: "clerk",
                cleanup_deferred: true,
                previous_profile: { email: "parent@example.com" },
              }),
            ]
          )
          await db.query("UPDATE public.user_access SET is_enabled=false WHERE user_id=$1", [
            member!.supabaseUuid,
          ])
        }
        expect(
          (await deliver(kind === "provider404" ? "user.updated" : "user.deleted")).status
        ).toBe(200)
        expect(
          await db.query(
            "SELECT email,display_name,child_name,child_age FROM public.user_profiles WHERE id=$1",
            [member!.supabaseUuid]
          )
        ).toEqual([{ email: null, display_name: null, child_name: null, child_age: null }])
        expect(
          await db.query("SELECT user_id FROM public.favorites WHERE event_id=$1", [eventId])
        ).toEqual([{ user_id: other!.supabaseUuid }])
        expect(
          await db.query("SELECT user_id,body FROM public.comments WHERE event_id=$1", [eventId])
        ).toEqual([{ user_id: other!.supabaseUuid, body: "Other note" }])
        expect(await db.query("SELECT user_id FROM private.operator_presence")).toEqual([
          { user_id: other!.supabaseUuid },
        ])
        expect(await db.query("SELECT resolved_by FROM private.callback_evidence_fixture")).toEqual(
          [{ resolved_by: member!.supabaseUuid }]
        )
        const status = await admin("get", "/v1/admin/users/deletions")
        expect(status.body).toEqual([
          expect.objectContaining({
            user_id: member!.supabaseUuid,
            status: "cleanup_deferred",
            provider_confirmed_at: expect.any(String),
            last_error: "protected_attribution",
          }),
        ])
        expect(await identity.resolve("user_parent")).toBeNull()
        expect(
          (
            await request(app.getHttpServer())
              .get("/v1/admin/users")
              .set("Authorization", "Bearer old-parent-token")
          ).status
        ).toBe(403)
        expect(
          await db.query("SELECT action,metadata FROM public.admin_audit_log WHERE target_id=$1", [
            member!.supabaseUuid,
          ])
        ).toEqual([
          {
            action: "user.delete",
            metadata: expect.objectContaining({
              source: "clerk",
              cleanup_deferred: true,
              previous_profile: expect.objectContaining({ email: "parent@example.com" }),
            }),
          },
        ])
        expect((await deliver("user.deleted")).status).toBe(200)
        expect(
          await db.query("SELECT action FROM public.admin_audit_log WHERE target_id=$1", [
            member!.supabaseUuid,
          ])
        ).toEqual([{ action: "user.delete" }])
        await db.query("DELETE FROM private.callback_evidence_fixture")
        expect(
          (
            await request(app.getHttpServer())
              .delete(`/v1/admin/users/${member!.supabaseUuid}`)
              .set("Authorization", "Bearer operator-token")
              .send({})
          ).status
        ).toBe(200)
        expect((await admin("get", "/v1/admin/users/deletions")).body[0]).toMatchObject({
          status: "completed",
        })
        expect(
          await db.query("SELECT id FROM auth.users WHERE id=$1", [member!.supabaseUuid])
        ).toEqual([])
        expect((await deliver("user.deleted")).status).toBe(200)
        expect(fetch).not.toHaveBeenCalled()
      } finally {
        vi.unstubAllGlobals()
        await db.query("DROP TABLE private.callback_evidence_fixture")
      }
    }
  )
  it("never permits an operator to retry deletion of a retained administrator, while signed callback replays finish its cleanup", async () => {
    await operator()
    provider.users.getUser.mockResolvedValue(verifiedUser())
    await deliver("user.created")
    const member = await identity.resolve("user_parent")
    await db.query("UPDATE public.user_profiles SET role='admin' WHERE id=$1", [
      member!.supabaseUuid,
    ])
    await db.query(
      "CREATE TABLE private.callback_admin_evidence_fixture(resolved_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT)"
    )
    await db.query("INSERT INTO private.callback_admin_evidence_fixture VALUES($1)", [
      member!.supabaseUuid,
    ])
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    try {
      expect((await deliver("user.deleted")).status).toBe(200)
      expect((await admin("get", "/v1/admin/users/deletions")).body[0]).toMatchObject({
        status: "cleanup_deferred",
        attempts: 1,
      })
      expect(
        (
          await request(app.getHttpServer())
            .delete(`/v1/admin/users/${member!.supabaseUuid}`)
            .set("Authorization", "Bearer operator-token")
            .send({})
        ).status
      ).toBe(400)
      expect((await admin("get", "/v1/admin/users/deletions")).body[0]).toMatchObject({
        attempts: 1,
      })
      await db.query("DELETE FROM private.callback_admin_evidence_fixture")
      expect((await deliver("user.deleted")).status).toBe(200)
      expect((await admin("get", "/v1/admin/users/deletions")).body[0]).toMatchObject({
        status: "completed",
      })
      expect(
        await db.query("SELECT id FROM auth.users WHERE id=$1", [member!.supabaseUuid])
      ).toEqual([])
      expect(
        await db.query(
          "SELECT action FROM public.admin_audit_log WHERE target_id=$1 ORDER BY created_at",
          [member!.supabaseUuid]
        )
      ).toEqual([{ action: "user.delete" }, { action: "user.delete_cleanup_completed" }])
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
      await db.query("DROP TABLE private.callback_admin_evidence_fixture")
    }
  })
  it("keeps callback revocation durable when cleanup auditing fails and finishes on replay", async () => {
    await operator()
    provider.users.getUser.mockResolvedValue(verifiedUser())
    await deliver("user.created")
    const member = await identity.resolve("user_parent")
    await db.query(`CREATE FUNCTION public.fail_callback_cleanup_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='user.delete' THEN RAISE EXCEPTION 'fixture callback audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_callback_cleanup_audit BEFORE INSERT ON public.admin_audit_log FOR EACH ROW EXECUTE FUNCTION public.fail_callback_cleanup_audit()`)
    try {
      expect((await deliver("user.deleted")).status).toBe(503)
      expect(await identity.resolve("user_parent")).toBeNull()
      expect((await admin("get", "/v1/admin/users/deletions")).body[0]).toMatchObject({
        status: "pending_cleanup",
        provider_confirmed_at: expect.any(String),
        last_error: "cleanup_failed",
      })
      expect(
        await db.query("SELECT id FROM auth.users WHERE id=$1", [member!.supabaseUuid])
      ).toHaveLength(1)
      expect(
        await db.query(
          "SELECT status,payload,delivery FROM private.transactional_email_outbox WHERE target_id=$1",
          [member!.supabaseUuid]
        )
      ).toEqual([{ status: "cancelled", payload: null, delivery: null }])
    } finally {
      await db.query(
        "DROP TRIGGER fail_callback_cleanup_audit ON public.admin_audit_log; DROP FUNCTION public.fail_callback_cleanup_audit()"
      )
    }
    expect((await deliver("user.deleted")).status).toBe(200)
    expect((await admin("get", "/v1/admin/users/deletions")).body[0]).toMatchObject({
      status: "completed",
    })
    expect(await db.query("SELECT id FROM auth.users WHERE id=$1", [member!.supabaseUuid])).toEqual(
      []
    )
  })
  it("fences an in-flight operator provider acknowledgement after an authoritative deletion callback", async () => {
    await operator()
    provider.users.getUser.mockResolvedValue(verifiedUser())
    await deliver("user.created")
    const member = await identity.resolve("user_parent")
    let started!: () => void
    let release!: () => void
    const beginning = new Promise<void>((resolve) => {
      started = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetch = vi.fn(async () => {
      started()
      await held
      return new Response(JSON.stringify({ id: "user_parent", deleted: true }), { status: 200 })
    })
    vi.stubGlobal("fetch", fetch)
    const deletion = request(app.getHttpServer())
      .delete(`/v1/admin/users/${member!.supabaseUuid}`)
      .set("Authorization", "Bearer operator-token")
      .send({})
      .then((response) => response)
    try {
      await beginning
      expect((await deliver("user.deleted")).status).toBe(200)
      release()
      expect((await deletion).status).toBe(409)
      expect((await admin("get", "/v1/admin/users/deletions")).body[0]).toMatchObject({
        status: "completed",
        last_error: null,
      })
      expect((await deliver("user.deleted")).status).toBe(200)
      expect(await identity.resolve("user_parent")).toBeNull()
      expect(fetch).toHaveBeenCalledOnce()
    } finally {
      release()
      await deletion
      vi.unstubAllGlobals()
    }
  })
  it("rolls back revocation if its required audit cannot persist, without contacting Clerk", async () => {
    await operator()
    provider.users.getUser.mockResolvedValue(verifiedUser())
    await deliver("user.created")
    const mapping = await identity.resolve("user_parent")
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    await db.query(`CREATE FUNCTION public.fail_deletion_intent_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='user.delete_requested' THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_deletion_intent_audit BEFORE INSERT ON public.admin_audit_log FOR EACH ROW EXECUTE FUNCTION public.fail_deletion_intent_audit()`)
    try {
      expect(
        (
          await request(app.getHttpServer())
            .delete(`/v1/admin/users/${mapping!.supabaseUuid}`)
            .set("Authorization", "Bearer operator-token")
            .send({})
        ).status
      ).toBe(503)
      expect(await identity.resolve("user_parent")).not.toBeNull()
      expect((await admin("get", "/v1/admin/users/deletions")).body).toEqual([])
      expect(await identity.hasEnabledAccess(mapping!.supabaseUuid)).toBe(true)
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
      await db.query(
        "DROP TRIGGER fail_deletion_intent_audit ON public.admin_audit_log; DROP FUNCTION public.fail_deletion_intent_audit()"
      )
    }
  })
  it("retries failed UUID cleanup without repeating a confirmed provider deletion", async () => {
    await operator()
    provider.users.getUser.mockResolvedValue(verifiedUser())
    await deliver("user.created")
    const mapping = await identity.resolve("user_parent")
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "user_parent", deleted: true }), { status: 200 })
    )
    vi.stubGlobal("fetch", fetch)
    await db.query(`CREATE FUNCTION public.fail_deletion_cleanup_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='user.delete' THEN RAISE EXCEPTION 'fixture cleanup audit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_deletion_cleanup_audit BEFORE INSERT ON public.admin_audit_log FOR EACH ROW EXECUTE FUNCTION public.fail_deletion_cleanup_audit()`)
    try {
      expect(
        (
          await request(app.getHttpServer())
            .delete(`/v1/admin/users/${mapping!.supabaseUuid}`)
            .set("Authorization", "Bearer operator-token")
            .send({})
        ).status
      ).toBe(503)
      expect((await admin("get", "/v1/admin/users/deletions")).body[0]).toMatchObject({
        status: "pending_cleanup",
        last_error: "cleanup_failed",
        provider_confirmed_at: expect.any(String),
      })
      expect(await identity.resolve("user_parent")).toBeNull()
      expect(
        await db.query("SELECT id FROM auth.users WHERE id=$1", [mapping!.supabaseUuid])
      ).toHaveLength(1)
    } finally {
      await db.query(
        "DROP TRIGGER fail_deletion_cleanup_audit ON public.admin_audit_log; DROP FUNCTION public.fail_deletion_cleanup_audit()"
      )
    }
    try {
      expect(
        (
          await request(app.getHttpServer())
            .delete(`/v1/admin/users/${mapping!.supabaseUuid}`)
            .set("Authorization", "Bearer operator-token")
            .send({})
        ).status
      ).toBe(200)
      expect(fetch).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it("recovers a lost provider acknowledgement by confirming absence after the lease expires", async () => {
    await operator()
    provider.users.getUser.mockResolvedValue(verifiedUser())
    await deliver("user.created")
    const mapping = await identity.resolve("user_parent")
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "user_parent", deleted: true }), { status: 200 })
      )
      .mockResolvedValueOnce(new Response("{}", { status: 404 }))
    vi.stubGlobal("fetch", fetch)
    await db.query(`CREATE FUNCTION private.fail_deletion_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.provider_confirmed_at IS NOT NULL THEN RAISE EXCEPTION 'fixture acknowledgement failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_deletion_confirmation BEFORE UPDATE ON private.account_deletions FOR EACH ROW EXECUTE FUNCTION private.fail_deletion_confirmation()`)
    try {
      expect(
        (
          await request(app.getHttpServer())
            .delete(`/v1/admin/users/${mapping!.supabaseUuid}`)
            .set("Authorization", "Bearer operator-token")
            .send({})
        ).status
      ).toBe(503)
      expect((await admin("get", "/v1/admin/users/deletions")).body[0]).toMatchObject({
        status: "pending_provider",
        provider_confirmed_at: null,
      })
      expect(await identity.resolve("user_parent")).toBeNull()
    } finally {
      await db.query(
        "DROP TRIGGER fail_deletion_confirmation ON private.account_deletions; DROP FUNCTION private.fail_deletion_confirmation()"
      )
    }
    try {
      await db.query("UPDATE private.account_deletions SET locked_until=now()-interval '1 second'")
      expect(
        (
          await request(app.getHttpServer())
            .delete(`/v1/admin/users/${mapping!.supabaseUuid}`)
            .set("Authorization", "Bearer operator-token")
            .send({})
        ).status
      ).toBe(200)
      expect(fetch).toHaveBeenCalledTimes(2)
      expect((await admin("get", "/v1/admin/users/deletions")).body[0]).toMatchObject({
        status: "completed",
        attempts: 2,
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it("leases one concurrent deletion and never accepts malformed provider confirmation", async () => {
    await operator()
    provider.users.getUser.mockResolvedValue(verifiedUser())
    await deliver("user.created")
    const mapping = await identity.resolve("user_parent")
    let started!: () => void
    let release!: () => void
    const beginning = new Promise<void>((resolve) => {
      started = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetch = vi.fn(async () => {
      started()
      await held
      return new Response(JSON.stringify({ id: "user_other", deleted: true }), { status: 200 })
    })
    vi.stubGlobal("fetch", fetch)
    try {
      const path = `/v1/admin/users/${mapping!.supabaseUuid}`
      const first = request(app.getHttpServer())
        .delete(path)
        .set("Authorization", "Bearer operator-token")
        .send({})
        .then((response) => response)
      await beginning
      expect(
        (
          await request(app.getHttpServer())
            .delete(path)
            .set("Authorization", "Bearer operator-token")
            .send({})
        ).status
      ).toBe(409)
      release()
      expect((await first).status).toBe(503)
      expect(fetch).toHaveBeenCalledOnce()
      expect((await admin("get", "/v1/admin/users/deletions")).body[0]).toMatchObject({
        status: "pending_provider",
        last_error: "provider_invalid_response",
      })
    } finally {
      release()
      vi.unstubAllGlobals()
    }
  })
  it("preserves expiration when changing access and denies expired and disabled operators", async () => {
    await operator()
    provider.users.getUser.mockResolvedValue(verifiedUser())
    await deliver("user.created")
    const mapping = await identity.resolve("user_parent")
    const op = await identity.resolve("user_operator")
    await db.query(
      "UPDATE public.user_access SET is_enabled=false,access_expires_at='2020-01-01T10:00:00.123456Z' WHERE user_id=$1",
      [mapping!.supabaseUuid]
    )
    const enabled = await request(app.getHttpServer())
      .put(`/v1/admin/users/${mapping!.supabaseUuid}/access`)
      .set("Authorization", "Bearer operator-token")
      .send({ is_enabled: true, disabled_reason: "ignored" })
    expect(enabled.status).toBe(200)
    expect(enabled.body.access_expires_at).toContain(".123456")
    expect(enabled.body.disabled_reason).toBeNull()
    expect(await identity.hasEnabledAccess(mapping!.supabaseUuid)).toBe(false)
    await db.query(
      "UPDATE public.user_access SET access_expires_at=now()-interval '1 second' WHERE user_id=$1",
      [op!.supabaseUuid]
    )
    expect((await admin("get", "/v1/admin/users")).status).toBe(403)
    await db.query(
      "UPDATE public.user_access SET access_expires_at=NULL,is_enabled=false WHERE user_id=$1",
      [op!.supabaseUuid]
    )
    expect(
      (
        await request(app.getHttpServer())
          .delete(`/v1/admin/users/${mapping!.supabaseUuid}`)
          .set("Authorization", "Bearer operator-token")
          .send({})
      ).status
    ).toBe(403)
  })
  it("exposes capabilities without allowing self-disable or deletion of another administrator", async () => {
    await operator()
    provider.users.getUser.mockResolvedValue(verifiedUser())
    await deliver("user.created")
    const operatorMapping = await identity.resolve("user_operator")
    const member = await identity.resolve("user_parent")
    const rows = (await admin("get", "/v1/admin/users")).body
    expect(
      rows.find((row: { user_id: string }) => row.user_id === operatorMapping!.supabaseUuid)
    ).toMatchObject({ is_self: true, can_disable: false, can_enable: false, can_delete: false })
    expect(
      rows.find((row: { user_id: string }) => row.user_id === member!.supabaseUuid)
    ).toMatchObject({ is_self: false, can_disable: true, can_enable: false, can_delete: true })
  })
  it("retries a provider failure against the same identity and accepts authoritative absence", async () => {
    await operator()
    provider.users.getUser.mockResolvedValue(verifiedUser())
    await deliver("user.created")
    const mapping = await identity.resolve("user_parent")
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("absent", { status: 404 }))
    vi.stubGlobal("fetch", fetch)
    try {
      const path = `/v1/admin/users/${mapping!.supabaseUuid}`
      expect(
        (
          await request(app.getHttpServer())
            .delete(path)
            .set("Authorization", "Bearer operator-token")
            .send({})
        ).status
      ).toBe(503)
      expect(
        (
          await request(app.getHttpServer())
            .delete(path)
            .set("Authorization", "Bearer operator-token")
            .send({})
        ).status
      ).toBe(200)
      expect(
        (
          await request(app.getHttpServer())
            .delete(path)
            .set("Authorization", "Bearer operator-token")
            .send({})
        ).status
      ).toBe(200)
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(fetch.mock.calls.map((call) => call[0])).toEqual([
        "https://api.clerk.com/v1/users/user_parent",
        "https://api.clerk.com/v1/users/user_parent",
      ])
      expect((await admin("get", "/v1/admin/users/deletions")).body[0]).toMatchObject({
        status: "completed",
        attempts: 2,
        last_error: null,
      })
      expect(
        await db.query(
          "SELECT action FROM public.admin_audit_log WHERE target_id=$1 ORDER BY created_at",
          [mapping!.supabaseUuid]
        )
      ).toEqual([{ action: "user.delete_requested" }, { action: "user.delete" }])
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it("rejects self/admin/anonymous/member and invalid actor targeting without provider work", async () => {
    await operator()
    const operatorMapping = await identity.resolve("user_operator")
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    try {
      const path = `/v1/admin/users/${operatorMapping!.supabaseUuid}`
      expect(
        (
          await request(app.getHttpServer())
            .delete(path)
            .set("Authorization", "Bearer operator-token")
            .send({})
        ).status
      ).toBe(400)
      provider.users.getUser.mockResolvedValue(verifiedUser())
      await deliver("user.created")
      const member = await identity.resolve("user_parent")
      expect(
        (
          await request(app.getHttpServer())
            .delete(`/v1/admin/users/${member!.supabaseUuid}`)
            .send({})
        ).status
      ).toBe(401)
      expect(
        (
          await request(app.getHttpServer())
            .delete(path)
            .set("Authorization", "Bearer old-parent-token")
            .send({})
        ).status
      ).toBe(404)
      expect(
        (
          await request(app.getHttpServer())
            .delete(`/v1/admin/users/${member!.supabaseUuid}`)
            .set("Authorization", "Bearer operator-token")
            .send({ clerk_user_id: "user_operator" })
        ).status
      ).toBe(400)
      await db.query("UPDATE public.user_profiles SET role='admin' WHERE id=$1", [
        member!.supabaseUuid,
      ])
      expect(
        (
          await request(app.getHttpServer())
            .delete(`/v1/admin/users/${member!.supabaseUuid}`)
            .set("Authorization", "Bearer operator-token")
            .send({})
        ).status
      ).toBe(400)
      expect((await admin("get", "/v1/admin/users/deletions")).body).toEqual([])
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it("keeps protected historical UUID and evidence while cleaning personal rows after provider deletion", async () => {
    await operator()
    provider.users.getUser.mockResolvedValue(verifiedUser())
    await deliver("user.created")
    const mapping = await identity.resolve("user_parent")
    await db.query(
      "CREATE TABLE private.account_evidence_fixture (id uuid PRIMARY KEY,operator_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT)"
    )
    await db.query(
      "CREATE TABLE private.account_owned_fixture(user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE)"
    )
    await db.query("INSERT INTO private.account_owned_fixture(user_id) VALUES($1)", [
      mapping!.supabaseUuid,
    ])
    await db.query("INSERT INTO private.account_evidence_fixture(id,operator_id) VALUES($1,$2)", [
      randomUUID(),
      mapping!.supabaseUuid,
    ])
    const operatorMapping = await identity.resolve("user_operator")
    const eventId = randomUUID()
    await db.query(
      "INSERT INTO public.events(id,title,start_datetime) VALUES($1,'Account cleanup fixture',now())",
      [eventId]
    )
    await db.query("INSERT INTO public.favorites(user_id,event_id) VALUES($1,$3),($2,$3)", [
      mapping!.supabaseUuid,
      operatorMapping!.supabaseUuid,
      eventId,
    ])
    await db.query(
      "INSERT INTO public.comments(user_id,event_id,body) VALUES($1,$3,'Parent comment'),($2,$3,'Operator comment')",
      [mapping!.supabaseUuid, operatorMapping!.supabaseUuid, eventId]
    )
    await db.query("INSERT INTO private.operator_presence(user_id) VALUES($1),($2)", [
      mapping!.supabaseUuid,
      operatorMapping!.supabaseUuid,
    ])
    await db.query(
      "UPDATE public.user_profiles SET child_name='Child',child_age=4,avatar_url='https://example.com/avatar' WHERE id=$1",
      [mapping!.supabaseUuid]
    )
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ id: "user_parent", deleted: true }), { status: 200 })
      )
    )
    try {
      expect(
        (
          await request(app.getHttpServer())
            .delete(`/v1/admin/users/${mapping!.supabaseUuid}`)
            .set("Authorization", "Bearer operator-token")
            .send({})
        ).status
      ).toBe(409)
      expect((await admin("get", "/v1/admin/users/deletions")).body[0]).toMatchObject({
        status: "cleanup_deferred",
        last_error: "protected_attribution",
      })
      expect(await db.query("SELECT operator_id FROM private.account_evidence_fixture")).toEqual([
        { operator_id: mapping!.supabaseUuid },
      ])
      expect(
        await db.query(
          "SELECT email,display_name,child_name,child_age,avatar_url FROM public.user_profiles WHERE id=$1",
          [mapping!.supabaseUuid]
        )
      ).toEqual([
        { email: null, display_name: null, child_name: null, child_age: null, avatar_url: null },
      ])
      expect(await db.query("SELECT * FROM private.account_owned_fixture")).toEqual([])
      expect(
        await db.query("SELECT user_id FROM public.favorites WHERE event_id=$1", [eventId])
      ).toEqual([{ user_id: operatorMapping!.supabaseUuid }])
      expect(
        await db.query("SELECT user_id,body FROM public.comments WHERE event_id=$1", [eventId])
      ).toEqual([{ user_id: operatorMapping!.supabaseUuid, body: "Operator comment" }])
      expect(await db.query("SELECT user_id FROM private.operator_presence")).toEqual([
        { user_id: operatorMapping!.supabaseUuid },
      ])

      expect(await identity.resolve("user_parent")).toBeNull()
      expect((await deliver("user.created")).status).toBe(200)
    } finally {
      vi.unstubAllGlobals()
      await db.query(
        "DROP TABLE private.account_evidence_fixture; DROP TABLE private.account_owned_fixture"
      )
    }
  })
  it("keeps failed provider deletion revoked, scrubs uncertain welcome and refuses access resurrection", async () => {
    await operator()
    provider.users.getUser.mockResolvedValue(verifiedUser())
    await deliver("user.created")
    const mapping = await identity.resolve("user_parent")
    await db.query(
      "UPDATE private.transactional_email_outbox SET status='processing',attempts=1,first_attempt_at=now(),delivery=payload,locked_until=now()+interval '1 minute'"
    )
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 }))
    )
    try {
      expect(
        (
          await request(app.getHttpServer())
            .delete(`/v1/admin/users/${mapping!.supabaseUuid}`)
            .set("Authorization", "Bearer operator-token")
            .send({})
        ).status
      ).toBe(503)
      expect((await admin("get", "/v1/admin/users/deletions")).body[0]).toMatchObject({
        status: "pending_provider",
        last_error: "provider_503",
        provider_confirmed_at: null,
      })
      expect(await identity.resolve("user_parent")).toBeNull()
      expect(
        (
          await request(app.getHttpServer())
            .get("/v1/admin/users")
            .set("Authorization", "Bearer old-parent-token")
        ).status
      ).toBe(403)
      expect(
        await db.query("SELECT status,payload,delivery FROM private.transactional_email_outbox")
      ).toEqual([{ status: "cancelled", payload: null, delivery: null }])
      expect(
        (
          await request(app.getHttpServer())
            .put(`/v1/admin/users/${mapping!.supabaseUuid}/access`)
            .set("Authorization", "Bearer operator-token")
            .send({ is_enabled: true })
        ).status
      ).toBe(400)
      expect((await deliver("user.updated")).status).toBe(200)
      expect(await identity.resolve("user_parent")).toBeNull()
      provider.users.getUser.mockResolvedValue(verifiedUser("user_replacement"))
      expect((await deliver("user.created", "user_replacement")).status).toBe(409)
      expect(await identity.resolve("user_replacement")).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it("deletes the trusted Clerk identity and UUID rows together, with durable evidence and replay protection", async () => {
    await operator()
    provider.users.getUser.mockResolvedValue(verifiedUser())
    await deliver("user.created")
    const mapping = await identity.resolve("user_parent")
    const sends: Array<{ url: string; method: string; authorization: string }> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, input: RequestInit) => {
        sends.push({
          url: String(url),
          method: String(input.method),
          authorization: new Headers(input.headers).get("Authorization") ?? "",
        })
        return new Response(JSON.stringify({ id: "user_parent", object: "user", deleted: true }), {
          status: 200,
        })
      })
    )
    try {
      const response = await request(app.getHttpServer())
        .delete(`/v1/admin/users/${mapping!.supabaseUuid}`)
        .set("Authorization", "Bearer operator-token")
        .send({})
      expect(response.status).toBe(200)
      expect(sends).toEqual([
        {
          url: "https://api.clerk.com/v1/users/user_parent",
          method: "DELETE",
          authorization: "Bearer sk_test_fixture",
        },
      ])
      expect(await identity.resolve("user_parent")).toBeNull()
      expect(
        await db.query("SELECT id FROM auth.users WHERE id=$1", [mapping!.supabaseUuid])
      ).toEqual([])
      expect((await admin("get", "/v1/admin/users/deletions")).body[0]).toMatchObject({
        user_id: mapping!.supabaseUuid,
        status: "completed",
      })
      expect((await deliver("user.updated")).status).toBe(200)
      expect(await identity.resolve("user_parent")).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
