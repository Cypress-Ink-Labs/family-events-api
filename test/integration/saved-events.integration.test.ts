import { randomUUID } from "node:crypto"
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

describe("saved-event management HTTP ownership", () => {
  let app: INestApplication
  let db: DbService
  let idea: string
  let planned: string
  let both: string
  let hidden: string

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
    await db.query(
      `CREATE TABLE IF NOT EXISTS public.clerk_user_mapping (clerk_user_id text PRIMARY KEY, supabase_uuid uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE, email text NOT NULL, role text NOT NULL DEFAULT 'member', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`
    )
  })
  beforeEach(async () => {
    vi.mocked(verifyToken).mockImplementation(async (token) => {
      if (token === "mine") return { sub: "user_saved" } as Awaited<ReturnType<typeof verifyToken>>
      if (token === "other") return { sub: "user_other" } as Awaited<ReturnType<typeof verifyToken>>
      if (token === "unmapped")
        return { sub: "user_unmapped" } as Awaited<ReturnType<typeof verifyToken>>
      throw new Error("Invalid fixture token")
    })
    await db.query(
      "TRUNCATE public.clerk_user_mapping, auth.users, public.cities, public.events, public.user_profiles CASCADE"
    )
    await db.query(
      "INSERT INTO auth.users(id, email) VALUES($1,'parent@example.test'),($2,'other@example.test')",
      [USER, OTHER]
    )
    await db.query(
      "INSERT INTO public.clerk_user_mapping(clerk_user_id, supabase_uuid, email) VALUES('user_saved',$1,'parent@example.test'),('user_other',$2,'other@example.test')",
      [USER, OTHER]
    )
    await db.query(
      "INSERT INTO public.user_profiles(id, email) VALUES($1,'parent@example.test'),($2,'other@example.test')",
      [USER, OTHER]
    )
    await db.query("INSERT INTO public.user_access(user_id,is_enabled) VALUES($1,true),($2,true)", [
      USER,
      OTHER,
    ])
    await db.query(
      "INSERT INTO public.cities(id,name,slug,timezone) VALUES($1,'Honolulu','honolulu','Pacific/Honolulu')",
      [CITY]
    )
    const rows = await db.query<{ id: string }>(
      `INSERT INTO public.events(title,start_datetime,end_datetime,timezone,city_id,status,is_free,price,admission_cost_state,admission_cost_evidence)
      VALUES('Past idea','2026-01-01T18:00:00Z',NULL,'Pacific/Honolulu',$1,'published',false,NULL,'unknown',NULL),
      ('Future plan','2030-01-01T18:00:00Z',NULL,'Pacific/Honolulu',$1,'published',true,NULL,'free','Free admission'),
      ('Idea and plan','2030-01-02T18:00:00Z',NULL,'Pacific/Honolulu',$1,'published',false,10,'paid','Admission is $10'),
      ('Hidden saved draft','2030-01-03T18:00:00Z',NULL,'Pacific/Honolulu',$1,'draft',false,NULL,'unknown',NULL) RETURNING id`,
      [CITY]
    )
    ;[idea, planned, both, hidden] = rows.map((row) => row.id) as [string, string, string, string]
    await db.query(
      "INSERT INTO public.favorites(user_id,event_id) VALUES($1,$3),($1,$4),($1,$5),($2,$4)",
      [USER, OTHER, idea, both, hidden]
    )
    await db.query(
      "INSERT INTO public.user_calendar_events(user_id,event_id,notes) VALUES($1,$3,'Keep my notes'),($1,$4,'Bring snacks'),($1,$5,'Private draft note'),($2,$3,'Other parent note')",
      [USER, OTHER, both, planned, hidden]
    )
  })
  afterAll(async () => app.close())

  it("combines owner ideas and plans once, retains past saves without attendance, and excludes hidden listings", async () => {
    const result = await request(app.getHttpServer())
      .get("/v1/me/saved-events")
      .set("Authorization", "Bearer mine")
      .expect(200)
    expect(result.body.events.map((row: { id: string }) => row.id)).toEqual([idea, planned, both])
    expect(result.body.events[0]).toMatchObject({
      is_favorited: true,
      is_in_calendar: false,
      admission_cost_state: "unknown",
      timezone: "Pacific/Honolulu",
      calendar_notes: null,
    })
    expect(result.body.events[2]).toMatchObject({
      is_favorited: true,
      is_in_calendar: true,
      calendar_notes: "Keep my notes",
    })
    expect(result.body.events[0]).not.toHaveProperty("attended")
    expect(JSON.stringify(result.body)).not.toContain("Other parent note")
  })
  it("personalizes public calendar discovery without exposing owner notes or another person's saves", async () => {
    const query = { date_start: "2030-01-01", date_end: "2030-01-02", hide_past: "true" }
    const mine = await request(app.getHttpServer())
      .get("/v1/events")
      .query(query)
      .set("Authorization", "Bearer mine")
      .expect(200)
    expect(mine.body.events.find((row: { id: string }) => row.id === planned)).toMatchObject({
      is_favorited: false,
      is_in_calendar: true,
    })
    const other = await request(app.getHttpServer())
      .get("/v1/events")
      .query(query)
      .set("Authorization", "Bearer other")
      .expect(200)
    expect(other.body.events.find((row: { id: string }) => row.id === planned)).toMatchObject({
      is_favorited: false,
      is_in_calendar: false,
    })
    const anonymous = await request(app.getHttpServer()).get("/v1/events").query(query).expect(200)
    expect(
      anonymous.body.events.every(
        (row: { is_favorited: boolean; is_in_calendar: boolean }) =>
          !row.is_favorited && !row.is_in_calendar
      )
    ).toBe(true)
    for (const page of [mine, other, anonymous])
      expect(JSON.stringify(page.body)).not.toContain("Keep my notes")
  })

  it("removes both save types together and leaves another parent's records intact", async () => {
    await request(app.getHttpServer())
      .put(`/v1/events/${both}/rating`)
      .set("Authorization", "Bearer mine")
      .send({ score: 4 })
      .expect(200)
    const rated = await request(app.getHttpServer())
      .get("/v1/me/saved-events")
      .set("Authorization", "Bearer mine")
      .expect(200)
    expect(rated.body.events.find((row: { id: string }) => row.id === both)).toMatchObject({
      my_rating: 4,
    })
    await request(app.getHttpServer())
      .delete(`/v1/me/saved-events/${both}`)
      .set("Authorization", "Bearer mine")
      .expect(200, { ok: true })
    await request(app.getHttpServer())
      .delete(`/v1/me/saved-events/${both}`)
      .set("Authorization", "Bearer mine")
      .expect(200, { ok: true })
    const mine = await request(app.getHttpServer())
      .get("/v1/me/saved-events")
      .set("Authorization", "Bearer mine")
      .expect(200)
    expect(mine.body.events.map((row: { id: string }) => row.id)).toEqual([idea, planned])
    const other = await request(app.getHttpServer())
      .get("/v1/me/saved-events")
      .set("Authorization", "Bearer other")
      .expect(200)
    expect(other.body.events).toHaveLength(1)
    expect(other.body.events[0]).toMatchObject({
      id: both,
      is_favorited: true,
      is_in_calendar: true,
      calendar_notes: "Other parent note",
    })
    expect(other.body.events[0].my_rating).toBeNull()
    const ratings = await db.query(
      "SELECT score FROM public.ratings WHERE user_id=$1 AND event_id=$2",
      [USER, both]
    )
    expect(ratings).toEqual([{ score: 4 }])
  })

  it("rolls back favorite removal if removing the calendar record fails", async () => {
    await db.query(
      `CREATE OR REPLACE FUNCTION public.reject_saved_delete_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture deletion failure'; END $$`
    )
    await db.query(
      "CREATE TRIGGER reject_saved_delete_fixture BEFORE DELETE ON public.user_calendar_events FOR EACH ROW EXECUTE FUNCTION public.reject_saved_delete_fixture()"
    )
    try {
      await request(app.getHttpServer())
        .delete(`/v1/me/saved-events/${both}`)
        .set("Authorization", "Bearer mine")
        .expect(500)
      const result = await request(app.getHttpServer())
        .get("/v1/me/saved-events")
        .set("Authorization", "Bearer mine")
        .expect(200)
      expect(result.body.events.find((row: { id: string }) => row.id === both)).toMatchObject({
        is_favorited: true,
        is_in_calendar: true,
        calendar_notes: "Keep my notes",
      })
    } finally {
      await db.query("DROP TRIGGER reject_saved_delete_fixture ON public.user_calendar_events")
      await db.query("DROP FUNCTION public.reject_saved_delete_fixture()")
    }
  })

  it("keeps independent favorite and calendar changes reflected in the combined view", async () => {
    await request(app.getHttpServer())
      .put(`/v1/events/${both}/favorite`)
      .set("Authorization", "Bearer mine")
      .send({ on: false })
      .expect(200)
    const result = await request(app.getHttpServer())
      .get("/v1/me/saved-events")
      .set("Authorization", "Bearer mine")
      .expect(200)
    expect(result.body.events.find((row: { id: string }) => row.id === both)).toMatchObject({
      is_favorited: false,
      is_in_calendar: true,
      calendar_notes: "Keep my notes",
    })
    await request(app.getHttpServer())
      .put(`/v1/events/${both}/calendar`)
      .set("Authorization", "Bearer mine")
      .send({ on: false })
      .expect(200)
    const removed = await request(app.getHttpServer())
      .get("/v1/me/saved-events")
      .set("Authorization", "Bearer mine")
      .expect(200)
    expect(removed.body.events.some((row: { id: string }) => row.id === both)).toBe(false)
  })

  it("rejects identity selectors and malformed ids without changing any saves", async () => {
    await request(app.getHttpServer())
      .get(`/v1/me/saved-events?user_id=${OTHER}`)
      .set("Authorization", "Bearer mine")
      .expect(400)
    await request(app.getHttpServer())
      .delete(`/v1/me/saved-events/${both}?user_id=${OTHER}`)
      .set("Authorization", "Bearer mine")
      .expect(400)
    await request(app.getHttpServer())
      .delete(`/v1/me/saved-events/${both}`)
      .set("Authorization", "Bearer mine")
      .send({ user_id: OTHER })
      .expect(400)
    await request(app.getHttpServer())
      .delete("/v1/me/saved-events/bad-id")
      .set("Authorization", "Bearer mine")
      .expect(400)
    await request(app.getHttpServer())
      .delete(`/v1/me/saved-events/${randomUUID()}`)
      .set("Authorization", "Bearer mine")
      .expect(200)
    const result = await request(app.getHttpServer())
      .get("/v1/me/saved-events")
      .set("Authorization", "Bearer mine")
      .expect(200)
    expect(result.body.events).toHaveLength(3)
  })

  it.each(["signed-out", "unmapped", "disabled", "expired", "missing-access"])(
    "blocks %s from reading or removing private saves",
    async (state) => {
      if (state === "disabled")
        await db.query("UPDATE public.user_access SET is_enabled=false WHERE user_id=$1", [USER])
      if (state === "expired")
        await db.query(
          "UPDATE public.user_access SET access_expires_at=now()-interval '1 minute' WHERE user_id=$1",
          [USER]
        )
      if (state === "missing-access")
        await db.query("DELETE FROM public.user_access WHERE user_id=$1", [USER])
      for (const method of ["get", "delete"] as const) {
        const action = request(app.getHttpServer())[method](
          method === "get" ? "/v1/me/saved-events" : `/v1/me/saved-events/${both}`
        )
        if (state !== "signed-out")
          action.set("Authorization", `Bearer ${state === "unmapped" ? "unmapped" : "mine"}`)
        await action.expect(state === "signed-out" ? 401 : 403)
      }
      const favorites = await db.query(
        "SELECT event_id FROM public.favorites WHERE user_id=$1 AND event_id=$2",
        [USER, both]
      )
      expect(favorites).toHaveLength(1)
    }
  )
})
