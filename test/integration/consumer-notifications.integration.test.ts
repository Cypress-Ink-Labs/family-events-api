import { readFileSync } from "node:fs"
import { verifyToken } from "@clerk/backend"
import type { INestApplication } from "@nestjs/common"
import { ConfigModule, ConfigService } from "@nestjs/config"
import { Test } from "@nestjs/testing"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { ConsumerModule } from "../../src/consumer/consumer.module.js"
import { DbModule } from "../../src/db/db.module.js"
import { DbService } from "../../src/db/db.service.js"
import { PgExceptionFilter } from "../../src/common/pg-exception.filter.js"
import { ensureCatalogSchema } from "./catalog.js"
import { integrationDatabaseUrl } from "./db.js"

vi.mock("@clerk/backend", () => ({ verifyToken: vi.fn() }))

const USER = "11111111-1111-4111-8111-111111111111"
const OTHER = "22222222-2222-4222-8222-222222222222"
const OTHER_NOTIFICATION = "99999999-9999-4999-8999-999999999999"

describe("consumer notification HTTP ownership", () => {
  let app: INestApplication
  let db: DbService
  let config: ConfigService
  let publicKey: string
  let privateKey: string
  const endpoint = "https://fcm.googleapis.com/fcm/send/fixture-browser"

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              DATABASE_URL: integrationDatabaseUrl(),
              CLERK_SECRET_KEY: "sk_test_fixture",
              NODE_ENV: "test",
            }),
          ],
        }),
        DbModule,
        ConsumerModule,
      ],
    }).compile()
    app = module.createNestApplication()
    app.useGlobalFilters(new PgExceptionFilter(app.getHttpAdapter()))
    await app.init()
    db = app.get(DbService)
    config = app.get(ConfigService)
    const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])
    publicKey = Buffer.from(await crypto.subtle.exportKey("raw", keyPair.publicKey)).toString(
      "base64url"
    )
    privateKey = (await crypto.subtle.exportKey("jwk", keyPair.privateKey)).d!
    await ensureCatalogSchema(db)
    await db.query("CREATE SCHEMA IF NOT EXISTS auth")
    await db.query("CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY, email text)")
    await db.query(`CREATE TABLE IF NOT EXISTS public.clerk_user_mapping (
      clerk_user_id text PRIMARY KEY, supabase_uuid uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
      email text NOT NULL, role text NOT NULL DEFAULT 'member', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    )`)
    await db.query("DROP TABLE IF EXISTS public.user_notifications")
    await db.query(`CREATE TABLE public.user_notifications (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
      type text NOT NULL CHECK(type IN ('reminder', 'change', 'digest', 'system')), title text NOT NULL, body text NOT NULL,
      event_id uuid REFERENCES public.events(id) ON DELETE SET NULL, read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
    )`)
    await db.query(
      "DROP TABLE IF EXISTS public.user_notification_preferences, public.push_subscriptions"
    )
    await db.query(`CREATE TABLE public.user_notification_preferences (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
      reminder_email boolean NOT NULL DEFAULT true, reminder_push boolean NOT NULL DEFAULT true,
      change_email boolean NOT NULL DEFAULT true, change_push boolean NOT NULL DEFAULT true,
      digest_email boolean NOT NULL DEFAULT true, digest_push boolean NOT NULL DEFAULT false,
      digest_telegram boolean NOT NULL DEFAULT false, telegram_chat_id text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    )`)
    await db.query(`CREATE TABLE public.push_subscriptions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      platform text NOT NULL CHECK(platform IN ('web','ios','android')), endpoint text, token text, p256dh text, auth_key text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT push_subscriptions_web_unique UNIQUE NULLS NOT DISTINCT (user_id, endpoint),
      CONSTRAINT push_subscriptions_mobile_unique UNIQUE NULLS NOT DISTINCT (user_id, token),
      CONSTRAINT push_subscriptions_platform_fields CHECK(CASE WHEN platform='web' THEN endpoint IS NOT NULL AND p256dh IS NOT NULL AND auth_key IS NOT NULL ELSE token IS NOT NULL END)
    )`)
    await db.query(
      readFileSync("schema/migrations/20261008005000_push_subscription_devices.sql", "utf8")
    )
  })

  beforeEach(async () => {
    config.set("VAPID_PUBLIC_KEY", "")
    config.set("VAPID_PRIVATE_KEY", "")
    config.set("RESEND_API_KEY", "")
    config.set("NODE_ENV", "production")
    config.set("CUTOVER_REMINDERS", "false")
    config.set("CUTOVER_NOTIFY", "false")
    config.set("CUTOVER_DIGEST", "false")
    vi.mocked(verifyToken).mockImplementation(async (token) => {
      if (token === "mine")
        return { sub: "user_notifications" } as Awaited<ReturnType<typeof verifyToken>>
      if (token === "other") return { sub: "user_other" } as Awaited<ReturnType<typeof verifyToken>>
      if (token === "unmapped")
        return { sub: "user_unmapped" } as Awaited<ReturnType<typeof verifyToken>>
      throw new Error("Invalid fixture token")
    })
    await db.query("TRUNCATE public.clerk_user_mapping, auth.users, public.user_profiles CASCADE")
    await db.query(
      "INSERT INTO auth.users(id, email) VALUES ($1, 'parent@example.test'), ($2, 'other@example.test')",
      [USER, OTHER]
    )
    await db.query(
      "INSERT INTO public.clerk_user_mapping(clerk_user_id, supabase_uuid, email) VALUES ('user_notifications', $1, 'parent@example.test'), ('user_other', $2, 'other@example.test')",
      [USER, OTHER]
    )
    await db.query(
      "INSERT INTO public.user_profiles(id, email) VALUES ($1, 'parent@example.test'), ($2, 'other@example.test')",
      [USER, OTHER]
    )
    await db.query(
      "INSERT INTO public.user_access(user_id, is_enabled) VALUES ($1, true), ($2, true)",
      [USER, OTHER]
    )
    await db.query(
      `INSERT INTO public.user_notifications(user_id, type, title, body, created_at)
      SELECT $1::uuid, 'reminder', 'Fixture ' || n, 'Private reminder', '2026-10-01'::timestamptz + n * interval '1 minute'
      FROM generate_series(1, 25) n`,
      [USER]
    )
    await db.query(
      "INSERT INTO public.user_notifications(id, user_id, type, title, body) VALUES ($1, $2, 'system', 'Other parent private', 'Other private body')",
      [OTHER_NOTIFICATION, OTHER]
    )
  })
  afterAll(async () => app.close())

  it("returns only the owner's newest 20 notifications and counts unread beyond that page", async () => {
    const result = await request(app.getHttpServer())
      .get("/v1/me/notifications")
      .set("Authorization", "Bearer mine")
      .expect(200)
    expect(result.body.unread_count).toBe(25)
    expect(result.body.items).toHaveLength(20)
    expect(result.body.items[0]).toMatchObject({
      title: "Fixture 25",
      read_at: null,
      event_id: null,
    })
    expect(result.body.items[19].title).toBe("Fixture 6")
    expect(
      result.body.items.some((row: { title: string }) => row.title === "Other parent private")
    ).toBe(false)
    expect(result.body.items[0]).not.toHaveProperty("user_id")
  })

  it("marks one item idempotently and all 25 owner items while leaving another inbox unread", async () => {
    const first = await request(app.getHttpServer())
      .get("/v1/me/notifications")
      .set("Authorization", "Bearer mine")
      .expect(200)
    const id = first.body.items[0].id
    const marked = await request(app.getHttpServer())
      .put(`/v1/me/notifications/${id}/read`)
      .set("Authorization", "Bearer mine")
      .expect(200)
    expect(marked.body.unread_count).toBe(24)
    expect(marked.body.items[0].read_at).toEqual(expect.any(String))
    const retry = await request(app.getHttpServer())
      .put(`/v1/me/notifications/${id}/read`)
      .set("Authorization", "Bearer mine")
      .expect(200)
    expect(retry.body).toEqual(marked.body)
    const all = await request(app.getHttpServer())
      .put("/v1/me/notifications/read")
      .set("Authorization", "Bearer mine")
      .expect(200)
    expect(all.body.unread_count).toBe(0)
    expect(all.body.items.every((row: { read_at: string | null }) => row.read_at !== null)).toBe(
      true
    )
    const reread = await request(app.getHttpServer())
      .get("/v1/me/notifications")
      .set("Authorization", "Bearer mine")
      .expect(200)
    expect(reread.body).toEqual(all.body)
    const other = await request(app.getHttpServer())
      .get("/v1/me/notifications")
      .set("Authorization", "Bearer other")
      .expect(200)
    expect(other.body.unread_count).toBe(1)
    expect(other.body.items[0].read_at).toBeNull()
  })

  it("rejects owner injection, malformed identifiers and another member's item without marking anything", async () => {
    await request(app.getHttpServer())
      .get(`/v1/me/notifications?user_id=${OTHER}`)
      .set("Authorization", "Bearer mine")
      .expect(400)
    await request(app.getHttpServer())
      .put("/v1/me/notifications/read")
      .set("Authorization", "Bearer mine")
      .send({ user_id: OTHER })
      .expect(400)
    await request(app.getHttpServer())
      .put("/v1/me/notifications/invalid/read")
      .set("Authorization", "Bearer mine")
      .expect(400)
    await request(app.getHttpServer())
      .put(`/v1/me/notifications/${OTHER_NOTIFICATION}/read`)
      .set("Authorization", "Bearer mine")
      .expect(404)
    const other = await request(app.getHttpServer())
      .get("/v1/me/notifications")
      .set("Authorization", "Bearer other")
      .expect(200)
    expect(other.body.unread_count).toBe(1)
    const mine = await request(app.getHttpServer())
      .get("/v1/me/notifications")
      .set("Authorization", "Bearer mine")
      .expect(200)
    expect(mine.body.unread_count).toBe(25)
  })

  it("represents an empty inbox explicitly", async () => {
    await db.query("DELETE FROM public.user_notifications WHERE user_id = $1", [USER])
    const result = await request(app.getHttpServer())
      .get("/v1/me/notifications")
      .set("Authorization", "Bearer mine")
      .expect(200)
    expect(result.body).toEqual({ items: [], unread_count: 0 })
  })

  it("preserves six legacy values and reports unsupported or unconfigured delivery truthfully", async () => {
    await db.query(
      `INSERT INTO public.user_notification_preferences(user_id, reminder_email, reminder_push, change_email, change_push, digest_email, digest_push, digest_telegram, telegram_chat_id)
      VALUES($1, false, true, true, false, false, true, true, 'fixture-chat')`,
      [USER]
    )
    const result = await request(app.getHttpServer())
      .get("/v1/me/notification-preferences")
      .set("Authorization", "Bearer mine")
      .expect(200)
    expect(result.body.preferences).toEqual({
      reminder_email: false,
      reminder_push: true,
      change_email: true,
      change_push: false,
      digest_email: false,
      digest_push: true,
    })
    expect(result.body.delivery).toMatchObject({
      web_push_configured: false,
      email_configured: false,
      digest_push_supported: false,
      vapid_public_key: null,
    })
    expect(result.body.subscriptions).toEqual([])
    expect(JSON.stringify(result.body)).not.toContain("fixture-chat")
  })

  it("updates only supplied owner preferences and keeps Telegram and unsupported legacy digest-push untouched", async () => {
    await db.query(
      "INSERT INTO public.user_notification_preferences(user_id, digest_push, digest_telegram, telegram_chat_id) VALUES ($1, true, true, 'fixture-chat'), ($2, false, false, NULL)",
      [USER, OTHER]
    )
    const saved = await request(app.getHttpServer())
      .put("/v1/me/notification-preferences")
      .set("Authorization", "Bearer mine")
      .send({ reminder_email: false, change_email: false })
      .expect(200)
    expect(saved.body.preferences).toMatchObject({
      reminder_email: false,
      change_email: false,
      reminder_push: true,
      change_push: true,
      digest_email: true,
      digest_push: true,
    })
    const reread = await request(app.getHttpServer())
      .get("/v1/me/notification-preferences")
      .set("Authorization", "Bearer mine")
      .expect(200)
    expect(reread.body).toEqual(saved.body)
    const other = await request(app.getHttpServer())
      .get("/v1/me/notification-preferences")
      .set("Authorization", "Bearer other")
      .expect(200)
    expect(other.body.preferences.reminder_email).toBe(true)
    const telegram = await db.query<{ digest_telegram: boolean; telegram_chat_id: string }>(
      "SELECT digest_telegram, telegram_chat_id FROM public.user_notification_preferences WHERE user_id = $1",
      [USER]
    )
    expect(telegram[0]).toEqual({ digest_telegram: true, telegram_chat_id: "fixture-chat" })
  })

  it("registers real-shaped browser keys idempotently before enabling push and removes only owner web subscriptions when push is disabled", async () => {
    config.set("VAPID_PUBLIC_KEY", publicKey)
    config.set("VAPID_PRIVATE_KEY", privateKey)
    const subscription = {
      endpoint,
      p256dh: publicKey,
      auth_key: Buffer.alloc(16, 1).toString("base64url"),
    }
    const registered = await request(app.getHttpServer())
      .post("/v1/me/push-subscriptions")
      .set("Authorization", "Bearer mine")
      .send(subscription)
      .expect(201)
    const retry = await request(app.getHttpServer())
      .post("/v1/me/push-subscriptions")
      .set("Authorization", "Bearer mine")
      .send(subscription)
      .expect(201)
    expect(retry.body).toEqual(registered.body)
    expect(registered.body).toEqual({ id: expect.any(String), endpoint })
    const enabled = await request(app.getHttpServer())
      .put("/v1/me/notification-preferences")
      .set("Authorization", "Bearer mine")
      .send({ reminder_push: true, browser_subscription_id: registered.body.id })
      .expect(200)
    expect(enabled.body.preferences.reminder_push).toBe(true)
    expect(enabled.body.delivery.web_push_configured).toBe(true)
    expect(enabled.body.delivery.vapid_public_key).toBe(publicKey)
    expect(enabled.body.subscriptions).toEqual([registered.body])
    await db.query(
      "INSERT INTO public.push_subscriptions(user_id, platform, token) VALUES($1, 'android', 'fixture-mobile')",
      [USER]
    )
    const other = await request(app.getHttpServer())
      .post("/v1/me/push-subscriptions")
      .set("Authorization", "Bearer other")
      .send({ ...subscription, endpoint: endpoint + "-other" })
      .expect(201)
    const disabled = await request(app.getHttpServer())
      .put("/v1/me/notification-preferences")
      .set("Authorization", "Bearer mine")
      .send({ reminder_push: false, change_push: false })
      .expect(200)
    expect(disabled.body.subscriptions).toEqual([])
    expect(disabled.body.preferences).toMatchObject({ reminder_push: false, change_push: false })
    const otherState = await request(app.getHttpServer())
      .get("/v1/me/notification-preferences")
      .set("Authorization", "Bearer other")
      .expect(200)
    expect(otherState.body.subscriptions).toEqual([other.body])
    const mobile = await db.query(
      "SELECT token FROM public.push_subscriptions WHERE user_id = $1 AND platform = 'android'",
      [USER]
    )
    expect(mobile).toEqual([{ token: "fixture-mobile" }])
    expect(JSON.stringify(enabled.body)).not.toContain(privateKey)
  })

  it("supports a second browser and mobile device without replacing another saved device", async () => {
    config.set("VAPID_PUBLIC_KEY", publicKey)
    config.set("VAPID_PRIVATE_KEY", privateKey)
    const subscription = {
      endpoint,
      p256dh: publicKey,
      auth_key: Buffer.alloc(16, 1).toString("base64url"),
    }
    await request(app.getHttpServer())
      .post("/v1/me/push-subscriptions")
      .set("Authorization", "Bearer mine")
      .send(subscription)
      .expect(201)
    await request(app.getHttpServer())
      .post("/v1/me/push-subscriptions")
      .set("Authorization", "Bearer mine")
      .send({ ...subscription, endpoint: endpoint + "-second" })
      .expect(201)
    await db.query(
      "INSERT INTO public.push_subscriptions(user_id, platform, token) VALUES($1, 'android', 'fixture-mobile-one'), ($1, 'ios', 'fixture-mobile-two')",
      [USER]
    )
    const result = await request(app.getHttpServer())
      .get("/v1/me/notification-preferences")
      .set("Authorization", "Bearer mine")
      .expect(200)
    expect(result.body.subscriptions).toHaveLength(2)
    expect(
      (await db.query("SELECT id FROM public.push_subscriptions WHERE user_id = $1", [USER])).length
    ).toBe(4)
    await expect(
      db.withTransaction((client) =>
        client.query(
          readFileSync(
            "schema/migrations/20261008005000_push_subscription_devices_down.sql",
            "utf8"
          )
        )
      )
    ).rejects.toThrow("rollback blocked")
    expect(
      (await db.query("SELECT id FROM public.push_subscriptions WHERE user_id = $1", [USER])).length
    ).toBe(4)
  })

  it("rolls back and reapplies device uniqueness while preserving registrations that fit the legacy rules", async () => {
    await db.query(
      "INSERT INTO public.push_subscriptions(user_id, platform, token) VALUES($1, 'android', 'fixture-mobile')",
      [USER]
    )
    await db.withTransaction((client) =>
      client.query(
        readFileSync("schema/migrations/20261008005000_push_subscription_devices_down.sql", "utf8")
      )
    )
    expect(
      await db.query("SELECT token FROM public.push_subscriptions WHERE user_id = $1", [USER])
    ).toEqual([{ token: "fixture-mobile" }])
    await db.withTransaction((client) =>
      client.query(
        readFileSync("schema/migrations/20261008005000_push_subscription_devices.sql", "utf8")
      )
    )
    expect(
      await db.query("SELECT token FROM public.push_subscriptions WHERE user_id = $1", [USER])
    ).toEqual([{ token: "fixture-mobile" }])
  })

  it("rejects unregistered, unconfigured and unsupported push choices without changing saved preferences", async () => {
    await request(app.getHttpServer())
      .put("/v1/me/notification-preferences")
      .set("Authorization", "Bearer mine")
      .send({ reminder_push: true })
      .expect(503)
    const subscription = {
      endpoint,
      p256dh: publicKey,
      auth_key: Buffer.alloc(16, 1).toString("base64url"),
    }
    await request(app.getHttpServer())
      .post("/v1/me/push-subscriptions")
      .set("Authorization", "Bearer mine")
      .send(subscription)
      .expect(503)
    config.set("VAPID_PUBLIC_KEY", publicKey)
    config.set("VAPID_PRIVATE_KEY", privateKey)
    await request(app.getHttpServer())
      .put("/v1/me/notification-preferences")
      .set("Authorization", "Bearer mine")
      .send({ reminder_push: true })
      .expect(400)
    await request(app.getHttpServer())
      .put("/v1/me/notification-preferences")
      .set("Authorization", "Bearer mine")
      .send({ digest_push: true })
      .expect(400)
    const original = await request(app.getHttpServer())
      .get("/v1/me/notification-preferences")
      .set("Authorization", "Bearer mine")
      .expect(200)
    expect(original.body.preferences).toEqual({
      reminder_email: true,
      reminder_push: true,
      change_email: true,
      change_push: true,
      digest_email: true,
      digest_push: false,
    })
    expect(original.body.subscriptions).toEqual([])
  })

  it("isolates registration, enablement and deletion from another owner, including duplicate endpoint races", async () => {
    config.set("VAPID_PUBLIC_KEY", publicKey)
    config.set("VAPID_PRIVATE_KEY", privateKey)
    const subscription = {
      endpoint,
      p256dh: publicKey,
      auth_key: Buffer.alloc(16, 1).toString("base64url"),
    }
    const raced = await Promise.all(
      ["mine", "other"].map((token) =>
        request(app.getHttpServer())
          .post("/v1/me/push-subscriptions")
          .set("Authorization", `Bearer ${token}`)
          .send(subscription)
      )
    )
    expect(raced.map((result) => result.status).toSorted()).toEqual([201, 409])
    const winner = raced[0]!.status === 201 ? "mine" : "other"
    const loser = winner === "mine" ? "other" : "mine"
    const registered = raced.find((result) => result.status === 201)!.body
    await request(app.getHttpServer())
      .put("/v1/me/notification-preferences")
      .set("Authorization", `Bearer ${loser}`)
      .send({ change_push: true, browser_subscription_id: registered.id })
      .expect(400)
    await request(app.getHttpServer())
      .delete(`/v1/me/push-subscriptions/${registered.id}`)
      .set("Authorization", `Bearer ${loser}`)
      .expect(404)
    const before = await request(app.getHttpServer())
      .get("/v1/me/notification-preferences")
      .set("Authorization", `Bearer ${winner}`)
      .expect(200)
    expect(before.body.subscriptions).toEqual([registered])
    const removed = await request(app.getHttpServer())
      .delete(`/v1/me/push-subscriptions/${registered.id}`)
      .set("Authorization", `Bearer ${winner}`)
      .expect(200)
    expect(removed.body.subscriptions).toEqual([])
  })

  it.each([
    { role: "admin" },
    { user_id: OTHER, change_email: false },
    { reminder_email: "false" },
    {},
    { browser_subscription_id: OTHER },
  ])("rejects invalid or privileged preference patches: %j", async (input) => {
    await request(app.getHttpServer())
      .put("/v1/me/notification-preferences")
      .set("Authorization", "Bearer mine")
      .send(input)
      .expect(400)
  })

  it.each([
    "https://127.0.0.1/push",
    "https://example.test/push",
    "http://fcm.googleapis.com/push",
    "https://fcm.googleapis.com:8443/push",
    "https://user:pass@fcm.googleapis.com/push",
  ])("rejects unsupported browser endpoints: %s", async (url) => {
    config.set("VAPID_PUBLIC_KEY", publicKey)
    config.set("VAPID_PRIVATE_KEY", privateKey)
    await request(app.getHttpServer())
      .post("/v1/me/push-subscriptions")
      .set("Authorization", "Bearer mine")
      .send({
        endpoint: url,
        p256dh: publicKey,
        auth_key: Buffer.alloc(16, 1).toString("base64url"),
      })
      .expect(400)
  })

  it("rejects malformed encryption keys and invalid VAPID configuration without contacting a provider", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No provider calls permitted"))
    try {
      config.set("VAPID_PUBLIC_KEY", publicKey)
      config.set("VAPID_PRIVATE_KEY", privateKey)
      await request(app.getHttpServer())
        .post("/v1/me/push-subscriptions")
        .set("Authorization", "Bearer mine")
        .send({ endpoint, p256dh: publicKey, auth_key: "short" })
        .expect(400)
      const invalidPoint = Buffer.alloc(65, 1)
      invalidPoint[0] = 4
      await request(app.getHttpServer())
        .post("/v1/me/push-subscriptions")
        .set("Authorization", "Bearer mine")
        .send({
          endpoint,
          p256dh: invalidPoint.toString("base64url"),
          auth_key: Buffer.alloc(16, 1).toString("base64url"),
        })
        .expect(400)
      config.set("VAPID_PRIVATE_KEY", "invalid-key")
      const result = await request(app.getHttpServer())
        .get("/v1/me/notification-preferences")
        .set("Authorization", "Bearer mine")
        .expect(200)
      expect(result.body.delivery).toMatchObject({
        web_push_configured: false,
        vapid_public_key: null,
        reminders_enabled: false,
        changes_enabled: false,
        digest_enabled: false,
      })
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      fetch.mockRestore()
    }
  })

  it.each([undefined, "invalid", "unmapped"])(
    "requires a verified mapped account for reads and marking: %s",
    async (token) => {
      const status = token === "unmapped" ? 403 : 401
      const headers = token ? { Authorization: `Bearer ${token}` } : {}
      await request(app.getHttpServer()).get("/v1/me/notifications").set(headers).expect(status)
      await request(app.getHttpServer())
        .put("/v1/me/notifications/read")
        .set(headers)
        .expect(status)
      await request(app.getHttpServer())
        .get("/v1/me/notification-preferences")
        .set(headers)
        .expect(status)
      await request(app.getHttpServer())
        .put("/v1/me/notification-preferences")
        .set(headers)
        .send({ reminder_email: false })
        .expect(status)
      await request(app.getHttpServer())
        .post("/v1/me/push-subscriptions")
        .set(headers)
        .send({})
        .expect(status)
      await request(app.getHttpServer())
        .delete(`/v1/me/push-subscriptions/${OTHER_NOTIFICATION}`)
        .set(headers)
        .expect(status)
    }
  )

  it.each(["disabled", "expired", "missing"])(
    "denies inbox reads and writes for %s access",
    async (state) => {
      if (state === "missing")
        await db.query("DELETE FROM public.user_access WHERE user_id = $1", [USER])
      else
        await db.query(
          "UPDATE public.user_access SET is_enabled = $2, access_expires_at = $3 WHERE user_id = $1",
          [USER, state !== "disabled", state === "expired" ? "2020-01-01" : null]
        )
      await request(app.getHttpServer())
        .get("/v1/me/notifications")
        .set("Authorization", "Bearer mine")
        .expect(403)
      await request(app.getHttpServer())
        .put("/v1/me/notifications/read")
        .set("Authorization", "Bearer mine")
        .expect(403)
      await request(app.getHttpServer())
        .get("/v1/me/notification-preferences")
        .set("Authorization", "Bearer mine")
        .expect(403)
      await request(app.getHttpServer())
        .put("/v1/me/notification-preferences")
        .set("Authorization", "Bearer mine")
        .send({ reminder_email: false })
        .expect(403)
      await request(app.getHttpServer())
        .post("/v1/me/push-subscriptions")
        .set("Authorization", "Bearer mine")
        .send({})
        .expect(403)
      await request(app.getHttpServer())
        .delete(`/v1/me/push-subscriptions/${OTHER_NOTIFICATION}`)
        .set("Authorization", "Bearer mine")
        .expect(403)
      await db.query(
        "INSERT INTO public.user_access(user_id, is_enabled, access_expires_at) VALUES ($1, true, NULL) ON CONFLICT(user_id) DO UPDATE SET is_enabled = true, access_expires_at = NULL",
        [USER]
      )
      const result = await request(app.getHttpServer())
        .get("/v1/me/notifications")
        .set("Authorization", "Bearer mine")
        .expect(200)
      expect(result.body.unread_count).toBe(25)
    }
  )
})
