import { verifyToken } from "@clerk/backend"
import type { INestApplication } from "@nestjs/common"
import { ConfigModule } from "@nestjs/config"
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
  })

  beforeEach(async () => {
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
