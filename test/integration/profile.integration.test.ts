import { readFileSync } from "node:fs"
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
const CITY = "33333333-3333-4333-8333-333333333333"
const OTHER_CITY = "44444444-4444-4444-8444-444444444444"
const migrationPath = "schema/migrations/20261008002000_profile_theme_preference"

describe("profile and preferred-city HTTP ownership", () => {
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
    await db.query(readFileSync(`${migrationPath}.sql`, "utf8"))
    await db.query("CREATE SCHEMA IF NOT EXISTS auth")
    await db.query("CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY, email text)")
    await db.query(`CREATE TABLE IF NOT EXISTS public.clerk_user_mapping (
      clerk_user_id text PRIMARY KEY, supabase_uuid uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
      email text NOT NULL, role text NOT NULL DEFAULT 'member', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    )`)
    await db.query(`CREATE TABLE IF NOT EXISTS public.user_access (
      user_id uuid PRIMARY KEY REFERENCES public.user_profiles(id) ON DELETE CASCADE,
      is_enabled boolean NOT NULL DEFAULT false, access_expires_at timestamptz
    )`)
  })

  beforeEach(async () => {
    vi.mocked(verifyToken).mockImplementation(async (token) => {
      if (token === "mine")
        return { sub: "user_profile" } as Awaited<ReturnType<typeof verifyToken>>
      if (token === "other") return { sub: "user_other" } as Awaited<ReturnType<typeof verifyToken>>
      if (token === "unmapped")
        return { sub: "user_unmapped" } as Awaited<ReturnType<typeof verifyToken>>
      throw new Error("Invalid fixture token")
    })
    await db.query(
      "TRUNCATE public.user_access, public.clerk_user_mapping, auth.users, public.cities, public.user_profiles CASCADE"
    )
    await db.query(
      "INSERT INTO auth.users(id, email) VALUES ($1, 'parent@example.test'), ($2, 'other@example.test')",
      [USER, OTHER]
    )
    await db.query(
      `INSERT INTO public.clerk_user_mapping(clerk_user_id, supabase_uuid, email)
      VALUES ('user_profile', $1, 'parent@example.test'), ('user_other', $2, 'other@example.test')`,
      [USER, OTHER]
    )
    await db.query(
      `INSERT INTO public.cities(id, name, slug, timezone) VALUES
      ($1, 'Lafayette', 'lafayette', 'America/Chicago'), ($2, 'Baton Rouge', 'baton-rouge', 'America/Chicago')`,
      [CITY, OTHER_CITY]
    )
    await db.query(
      `INSERT INTO public.user_profiles(id, email, display_name, child_name, child_age, city_preference_id)
      VALUES ($1, 'parent@example.test', 'Existing parent', 'Existing child', 7, $3), ($2, 'other@example.test', 'Other parent', NULL, NULL, NULL)`,
      [USER, OTHER, CITY]
    )
    await db.query(
      "INSERT INTO public.user_access(user_id, is_enabled) VALUES ($1, true), ($2, true)",
      [USER, OTHER]
    )
    await db.query(
      "INSERT INTO public.user_preferred_cities(user_id, city_id, is_primary) VALUES ($1, $2, true)",
      [USER, CITY]
    )
  })

  afterAll(async () => {
    await app.close()
  })

  it("returns existing nullable profile and child settings through the mapped owner", async () => {
    const result = await request(app.getHttpServer())
      .get("/v1/me/profile")
      .set("Authorization", "Bearer mine")
      .expect(200)
    expect(result.body).toMatchObject({
      display_name: "Existing parent",
      child_name: "Existing child",
      child_age: 7,
      city_preference_id: CITY,
    })
    expect(result.body).not.toHaveProperty("role")
    expect(result.body).not.toHaveProperty("email")
  })

  it("persists trimmed profile edits, explicit unknown child age, and the chosen theme without changing the other account", async () => {
    const saved = await request(app.getHttpServer())
      .put("/v1/me/profile")
      .set("Authorization", "Bearer mine")
      .send({
        display_name: "  Updated parent  ",
        child_name: "",
        child_age: null,
        theme_preference: "dark",
      })
      .expect(200)
    expect(saved.body).toMatchObject({
      display_name: "Updated parent",
      child_name: null,
      child_age: null,
      theme_preference: "dark",
      city_preference_id: CITY,
    })
    const reread = await request(app.getHttpServer())
      .get("/v1/me/profile")
      .set("Authorization", "Bearer mine")
      .expect(200)
    expect(reread.body).toEqual(saved.body)
    const other = await request(app.getHttpServer())
      .get("/v1/me/profile")
      .set("Authorization", "Bearer other")
      .expect(200)
    expect(other.body).toMatchObject({
      display_name: "Other parent",
      child_name: null,
      child_age: null,
      theme_preference: null,
    })
  })

  it("preserves omitted settings and switches primary city using the existing atomic operation", async () => {
    await request(app.getHttpServer())
      .put("/v1/me/profile")
      .set("Authorization", "Bearer mine")
      .send({ child_age: 0 })
      .expect(200)
    await request(app.getHttpServer())
      .put("/v1/me/preferred-cities")
      .set("Authorization", "Bearer mine")
      .send({ city_ids: [CITY, OTHER_CITY], primary_city_id: OTHER_CITY })
      .expect(200)
    const profile = await request(app.getHttpServer())
      .get("/v1/me/profile")
      .set("Authorization", "Bearer mine")
      .expect(200)
    expect(profile.body).toEqual({
      display_name: "Existing parent",
      child_name: "Existing child",
      child_age: 0,
      city_preference_id: OTHER_CITY,
      theme_preference: null,
    })
    const cities = await request(app.getHttpServer())
      .get("/v1/me/preferred-cities")
      .set("Authorization", "Bearer mine")
      .expect(200)
    expect(
      cities.body
        .map((row: { city_id: string; is_primary: boolean }) => ({
          city_id: row.city_id,
          is_primary: row.is_primary,
        }))
        .toSorted((a: { city_id: string }, b: { city_id: string }) =>
          a.city_id.localeCompare(b.city_id)
        )
    ).toEqual([
      { city_id: CITY, is_primary: false },
      { city_id: OTHER_CITY, is_primary: true },
    ])
    const other = await request(app.getHttpServer())
      .get("/v1/me/preferred-cities")
      .set("Authorization", "Bearer other")
      .expect(200)
    expect(other.body).toEqual([])
  })

  it.each([
    { child_age: -1 },
    { child_age: 19 },
    { child_age: 3.5 },
    { child_age: "7" },
    { theme_preference: "purple" },
    { theme_preference: null },
    { display_name: 123 },
    { role: "admin" },
    { id: OTHER, display_name: "Stolen" },
    { child_name: [] },
    {},
  ])(
    "rejects invalid or privileged profile writes without changing saved values: %j",
    async (body) => {
      await request(app.getHttpServer())
        .put("/v1/me/profile")
        .set("Authorization", "Bearer mine")
        .send(body)
        .expect(400)
      const profile = await request(app.getHttpServer())
        .get("/v1/me/profile")
        .set("Authorization", "Bearer mine")
        .expect(200)
      expect(profile.body.display_name).toBe("Existing parent")
      expect(profile.body.child_age).toBe(7)
    }
  )

  it.each([undefined, "invalid", "unmapped"])(
    "rejects unverified or unprovisioned identity: %s",
    async (token) => {
      const headers = token ? { Authorization: `Bearer ${token}` } : {}
      const status = token === "unmapped" ? 403 : 401
      await request(app.getHttpServer()).get("/v1/me/profile").set(headers).expect(status)
      await request(app.getHttpServer())
        .put("/v1/me/profile")
        .set(headers)
        .send({ display_name: "Untrusted" })
        .expect(status)
    }
  )

  it("rejects attempted owner selection on reads and invalid preferred-city sets", async () => {
    await request(app.getHttpServer())
      .get(`/v1/me/profile?user_id=${OTHER}`)
      .set("Authorization", "Bearer mine")
      .expect(400)
    for (const input of [
      { city_ids: [], primary_city_id: CITY },
      { city_ids: [CITY], primary_city_id: OTHER_CITY },
      { city_ids: [CITY], primary_city_id: CITY, user_id: OTHER },
    ])
      await request(app.getHttpServer())
        .put("/v1/me/preferred-cities")
        .set("Authorization", "Bearer mine")
        .send(input)
        .expect(400)
    const profile = await request(app.getHttpServer())
      .get("/v1/me/profile")
      .set("Authorization", "Bearer mine")
      .expect(200)
    expect(profile.body.city_preference_id).toBe(CITY)
  })

  it("rehearses theme rollback while retaining all legacy profile and preferred-city values", async () => {
    await request(app.getHttpServer())
      .put("/v1/me/profile")
      .set("Authorization", "Bearer mine")
      .send({ theme_preference: "light" })
      .expect(200)
    await db.query(readFileSync(`${migrationPath}_down.sql`, "utf8"))
    const [profile] = await db.query(
      "SELECT display_name, child_name, child_age, city_preference_id::text FROM public.user_profiles WHERE id = $1",
      [USER]
    )
    expect(profile).toEqual({
      display_name: "Existing parent",
      child_name: "Existing child",
      child_age: 7,
      city_preference_id: CITY,
    })
    const columns = await db.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'user_profiles' AND column_name = 'theme_preference'"
    )
    expect(columns).toEqual([])
    await db.query(readFileSync(`${migrationPath}.sql`, "utf8"))
    const restored = await request(app.getHttpServer())
      .get("/v1/me/profile")
      .set("Authorization", "Bearer mine")
      .expect(200)
    expect(restored.body.theme_preference).toBeNull()
  })

  it.each(["disabled", "expired", "missing"])(
    "denies settings and city changes for %s access",
    async (state) => {
      if (state === "missing")
        await db.query("DELETE FROM public.user_access WHERE user_id = $1", [USER])
      else
        await db.query(
          "UPDATE public.user_access SET is_enabled = $2, access_expires_at = $3 WHERE user_id = $1",
          [USER, state !== "disabled", state === "expired" ? "2020-01-01T00:00:00Z" : null]
        )
      await request(app.getHttpServer())
        .get("/v1/me/profile")
        .set("Authorization", "Bearer mine")
        .expect(403)
      await request(app.getHttpServer())
        .put("/v1/me/profile")
        .set("Authorization", "Bearer mine")
        .send({ display_name: "Denied" })
        .expect(403)
      await request(app.getHttpServer())
        .get("/v1/me/preferred-cities")
        .set("Authorization", "Bearer mine")
        .expect(403)
      await request(app.getHttpServer())
        .put("/v1/me/preferred-cities")
        .set("Authorization", "Bearer mine")
        .send({ city_ids: [OTHER_CITY], primary_city_id: OTHER_CITY })
        .expect(403)
      const [profile] = await db.query(
        "SELECT display_name, city_preference_id::text FROM public.user_profiles WHERE id = $1",
        [USER]
      )
      expect(profile).toEqual({ display_name: "Existing parent", city_preference_id: CITY })
    }
  )
})
