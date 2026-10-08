import { readFileSync } from "node:fs"
import { verifyToken } from "@clerk/backend"
import type { INestApplication } from "@nestjs/common"
import { ConfigModule } from "@nestjs/config"
import { Test } from "@nestjs/testing"
import request from "supertest"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
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

describe("next nonempty family planner HTTP", () => {
  let app: INestApplication
  let db: DbService
  let weatherFetch: ReturnType<typeof vi.fn>

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
              OPENWEATHER_API_KEY: "controlled-weather-fixture",
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
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2030-03-09T18:00:00Z"))
    weatherFetch = vi.fn(
      async (_url: string | URL | Request) =>
        new Response(
          JSON.stringify({ weather: [{ main: "Rain" }], main: { temp: 18 }, dt: 1899309600 }),
          { status: 200 }
        )
    )
    vi.stubGlobal("fetch", weatherFetch)
    vi.mocked(verifyToken).mockImplementation(async (token) => {
      if (token === "mine") return { sub: "user_plan" } as Awaited<ReturnType<typeof verifyToken>>
      if (token === "other") return { sub: "user_other" } as Awaited<ReturnType<typeof verifyToken>>
      if (token === "unmapped")
        return { sub: "user_missing" } as Awaited<ReturnType<typeof verifyToken>>
      throw new Error("Invalid fixture token")
    })
    await db.query(
      "TRUNCATE public.clerk_user_mapping, auth.users, public.cities, public.events, public.user_profiles CASCADE"
    )
    await db.query(
      "INSERT INTO auth.users(id,email) VALUES($1,'plan@example.test'),($2,'other@example.test')",
      [USER, OTHER]
    )
    await db.query(
      "INSERT INTO public.clerk_user_mapping(clerk_user_id,supabase_uuid,email) VALUES('user_plan',$1,'plan@example.test'),('user_other',$2,'other@example.test')",
      [USER, OTHER]
    )
    await db.query(
      "INSERT INTO public.cities(id,name,slug,timezone,latitude,longitude) VALUES($1,'Lafayette','lafayette','America/Chicago',30,-91),($2,'Honolulu','honolulu','Pacific/Honolulu',21,-157)",
      [CITY, OTHER_CITY]
    )
    await db.query(
      "INSERT INTO public.user_profiles(id,email,child_age,city_preference_id) VALUES($1,'plan@example.test',4,$3),($2,'other@example.test',14,$4)",
      [USER, OTHER, CITY, OTHER_CITY]
    )
    await db.query(
      "INSERT INTO public.user_preferred_cities(user_id,city_id,is_primary) VALUES($1,$3,true),($2,$4,true)",
      [USER, OTHER, CITY, OTHER_CITY]
    )
    await db.query("INSERT INTO public.user_access(user_id,is_enabled) VALUES($1,true),($2,true)", [
      USER,
      OTHER,
    ])
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
  afterAll(async () => app.close())

  async function event(
    date: string,
    options: {
      city?: string
      ageMin?: number
      ageMax?: number
      outdoor?: boolean
      title?: string
    } = {}
  ) {
    const rows = await db.query<{ id: string }>(
      "INSERT INTO public.events(title,start_datetime,city_id,timezone,status,age_min,age_max,is_outdoor,latitude,longitude,is_free,admission_cost_state) VALUES($1,$2,$3,'America/Chicago','published',$4,$5,$6,30,-91,false,'unknown') RETURNING id",
      [
        options.title ?? "Family outing",
        date,
        options.city ?? CITY,
        options.ageMin ?? null,
        options.ageMax ?? null,
        options.outdoor ?? null,
      ]
    )
    return rows[0]!.id
  }

  const dates = [
    "2030-03-09T20:00:00Z",
    "2030-03-10T18:00:00Z",
    "2030-03-11T18:00:00Z",
    "2030-03-12T18:00:00Z",
    "2030-03-13T18:00:00Z",
    "2030-03-14T18:00:00Z",
    "2030-03-15T18:00:00Z",
    "2030-03-16T18:00:00Z",
  ]
  it.each(dates.map((date, offset) => ({ date, offset })))(
    "returns the first nonempty day D$offset including D7",
    async ({ date, offset }) => {
      const id = await event(date)
      await event("2030-03-17T18:00:00Z")
      const result = await request(app.getHttpServer())
        .get("/v1/plan/next")
        .set("Authorization", "Bearer mine")
        .expect(200)
      expect(result.body.day_offset).toBe(offset)
      expect(result.body.planned.map((row: { event: { id: string } }) => row.event.id)).toEqual([
        id,
      ])
      expect(result.body).toMatchObject({
        timezone: "America/Chicago",
        context: { child_age: 4, city_ids: [CITY], location_source: "city" },
      })
      expect(result.body.planned[0].event).toMatchObject({
        admission_cost_state: "unknown",
        age_match: "unknown",
      })
      expect(result.body.planned[0].reasons).not.toContain("Matches your child's age")
      if (offset > 0) expect(result.body.planned[0].reasons).not.toContain("Fits current weather")
    }
  )
  it("returns an honest empty plan after D7 and excludes earlier starts today", async () => {
    await event("2030-03-09T17:00:00Z")
    await event("2030-03-17T05:00:00Z")
    const result = await request(app.getHttpServer())
      .get("/v1/plan/next")
      .set("Authorization", "Bearer mine")
      .expect(200)
    expect(result.body).toMatchObject({
      available: true,
      day_offset: null,
      date: null,
      planned: [],
    })
  })
  it("uses half-open local DST dates and recalculates at midnight", async () => {
    vi.setSystemTime(new Date("2030-03-10T06:00:00Z"))
    const id = await event("2030-03-11T04:59:59Z")
    const tomorrow = await event("2030-03-11T05:00:00Z")
    const today = await request(app.getHttpServer())
      .get("/v1/plan/next")
      .set("Authorization", "Bearer mine")
      .expect(200)
    expect(today.body).toMatchObject({ date: "2030-03-10", day_offset: 0 })
    expect(today.body.planned.map((row: { event: { id: string } }) => row.event.id)).toEqual([id])
    vi.setSystemTime(new Date("2030-03-11T05:00:00Z"))
    const rolled = await request(app.getHttpServer())
      .get("/v1/plan/next")
      .set("Authorization", "Bearer mine")
      .expect(200)
    expect(rolled.body).toMatchObject({ date: "2030-03-11", day_offset: 0 })
    expect(rolled.body.planned.map((row: { event: { id: string } }) => row.event.id)).toEqual([
      tomorrow,
    ])
  })
  it("ranks with persisted child age and saved ideas using controlled weather", async () => {
    const match = await event(dates[0]!, { ageMin: 3, ageMax: 6, outdoor: false })
    const mismatch = await event(dates[0]!, { ageMin: 12, ageMax: 16, outdoor: true })
    const saved = await event("2029-01-01T18:00:00Z")
    await db.query(
      "INSERT INTO public.event_family_need_evidence(event_id,claim,value,provenance_type,observed_at) VALUES($1,'indoor','supported','organizer',now())",
      [match]
    )
    await db.query(
      "INSERT INTO public.tags(id,name,slug) VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Storytime','storytime')"
    )
    await db.query(
      "INSERT INTO public.event_tags(event_id,tag_id) VALUES($1,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),($2,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')",
      [match, saved]
    )
    await db.query("INSERT INTO public.favorites(user_id,event_id) VALUES($1,$2)", [USER, saved])
    const result = await request(app.getHttpServer())
      .get("/v1/plan/next")
      .set("Authorization", "Bearer mine")
      .expect(200)
    expect(result.body.planned.map((row: { event: { id: string } }) => row.event.id)).toEqual([
      match,
      mismatch,
    ])
    expect(result.body.planned[0].reasons).toEqual(
      expect.arrayContaining([
        "Matches your child's age",
        "Matches your saved ideas",
        "Fits current weather",
        "Close by",
      ])
    )
    expect(result.body.planned[0].event).toMatchObject({
      age_match: "confirmed",
      family_needs: { sensory_friendly: "unknown" },
    })
    expect(weatherFetch).toHaveBeenCalledTimes(1)
    expect(String(weatherFetch.mock.calls[0]?.[0])).toContain("lat=30")
    expect(JSON.stringify(result.body)).not.toContain(USER)
    expect(JSON.stringify(result.body)).not.toContain("supabase_uuid")
  })
  it("changes persisted cities and supports validated location and child overrides", async () => {
    const mine = await event(dates[0]!)
    const elsewhere = await event(dates[0]!, { city: OTHER_CITY })
    await request(app.getHttpServer())
      .put("/v1/me/preferred-cities")
      .set("Authorization", "Bearer mine")
      .send({ city_ids: [OTHER_CITY], primary_city_id: OTHER_CITY })
      .expect(200)
    const result = await request(app.getHttpServer())
      .get("/v1/plan/next")
      .set("Authorization", "Bearer mine")
      .expect(200)
    expect(result.body.planned.map((row: { event: { id: string } }) => row.event.id)).toEqual([
      elsewhere,
    ])
    expect(result.body.timezone).toBe("Pacific/Honolulu")
    const override = await request(app.getHttpServer())
      .get(`/v1/plan/next?city_id=${CITY}&kid_age=12&lat=30.1&lng=-91.1`)
      .set("Authorization", "Bearer mine")
      .expect(200)
    expect(override.body.context).toEqual({
      city_ids: [CITY],
      child_age: 12,
      location_source: "device",
    })
    expect(override.body.planned[0].event.id).toBe(mine)
  })
  it("weather failure keeps plans with neutral reasons", async () => {
    await event(dates[0]!, { outdoor: false })
    weatherFetch.mockResolvedValue(new Response("unavailable", { status: 503 }))
    const result = await request(app.getHttpServer())
      .get("/v1/plan/next")
      .set("Authorization", "Bearer mine")
      .expect(200)
    expect(result.body.weather.available).toBe(false)
    expect(result.body.planned[0].reasons).not.toContain("Fits current weather")
  })
  it("keeps a one-sided age range unknown rather than claiming confirmed suitability", async () => {
    await event(dates[0]!, { ageMin: 3, outdoor: false })
    const result = await request(app.getHttpServer())
      .get("/v1/plan/next")
      .set("Authorization", "Bearer mine")
      .expect(200)
    expect(result.body.planned[0].event.age_match).toBe("unknown")
    expect(result.body.planned[0].reasons).not.toContain("Matches your child's age")
    expect(result.body.planned[0].reasons).not.toContain("Fits current weather")
  })
  it.each([
    "kid_age=-1",
    "kid_age=19",
    "lat=30",
    "lat=91&lng=0",
    "lat=0&lng=181",
    "lat=NaN&lng=0",
    `user_id=${OTHER}`,
    "city_id=bad",
  ])("rejects invalid planner input %s", async (query) => {
    await request(app.getHttpServer())
      .get(`/v1/plan/next?${query}`)
      .set("Authorization", "Bearer mine")
      .expect(400)
    expect(weatherFetch).not.toHaveBeenCalled()
  })
  it("blocks anonymous, unmapped and disabled callers before personalized reads or weather", async () => {
    await request(app.getHttpServer()).get("/v1/plan/next").expect(401)
    await request(app.getHttpServer())
      .get("/v1/plan/next")
      .set("Authorization", "Bearer unmapped")
      .expect(403)
    await db.query("UPDATE public.user_access SET is_enabled=false WHERE user_id=$1", [USER])
    await request(app.getHttpServer())
      .get("/v1/plan/next")
      .set("Authorization", "Bearer mine")
      .expect(403)
    expect(weatherFetch).not.toHaveBeenCalled()
  })
})
