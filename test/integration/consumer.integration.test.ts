import { randomUUID } from "node:crypto"

import { verifyToken } from "@clerk/backend"
import { type INestApplication } from "@nestjs/common"
import { ConfigModule } from "@nestjs/config"
import { Test } from "@nestjs/testing"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { AuthModule } from "../../src/auth/auth.module.js"
import { ConsumerModule } from "../../src/consumer/consumer.module.js"
import { DataModule } from "../../src/data/data.module.js"
import { DbModule } from "../../src/db/db.module.js"
import { DbService } from "../../src/db/db.service.js"
import { ensureCatalogSchema, ensureConsumerSimilaritySchema, truncateCatalog } from "./catalog.js"
import { integrationDatabaseUrl } from "./db.js"

vi.mock("@clerk/backend", () => ({
  verifyToken: vi.fn(async (token: string) => {
    if (token === "mapped-token") return { sub: "user_reader" }
    if (token === "other-token") return { sub: "user_other" }
    if (token === "unmapped-token") return { sub: "user_unmapped" }
    throw new Error("bad token")
  }),
}))

const CITY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const OTHER_CITY = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const INACTIVE_CITY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const TAG_FREE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
const TAG_OUTDOOR = "ffffffff-ffff-4fff-8fff-ffffffffffff"
const USER_READER = "99999999-9999-4999-8999-999999999999"
const USER_OTHER = "88888888-8888-4888-8888-888888888888"
const SIMILAR_VECTOR = `[1,${Array<number>(1535).fill(0).join(",")}]`

describe("consumer read HTTP API", () => {
  let app: INestApplication
  let db: DbService

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              DATABASE_URL: integrationDatabaseUrl(),
              CLERK_SECRET_KEY: "sk_test_x",
              NODE_ENV: "test",
            }),
          ],
        }),
        DbModule,
        DataModule,
        AuthModule,
        ConsumerModule,
      ],
    }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
    db = app.get(DbService)
    await ensureCatalogSchema(db)
    await ensureConsumerSimilaritySchema(db)
    await db.query("CREATE SCHEMA IF NOT EXISTS auth")
    await db.query("CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY)")
    await db.query(`CREATE TABLE IF NOT EXISTS public.clerk_user_mapping (
      clerk_user_id text PRIMARY KEY,
      supabase_uuid uuid NOT NULL UNIQUE REFERENCES auth.users (id) ON DELETE CASCADE,
      email text NOT NULL,
      role text NOT NULL DEFAULT 'member',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT clerk_user_mapping_clerk_id_shape_chk CHECK (clerk_user_id ~ '^user_'),
      CONSTRAINT clerk_user_mapping_role_chk CHECK (role IN ('operator', 'member'))
    )`)
  })

  beforeEach(async () => {
    vi.mocked(verifyToken).mockClear()
    await truncateCatalog(db)
    await db.query("TRUNCATE public.clerk_user_mapping, auth.users CASCADE")
    await db.query(
      `INSERT INTO public.cities (id, name, slug, state, timezone, latitude, longitude, is_active) VALUES
       ($1, 'Lafayette', 'lafayette', 'LA', 'America/Chicago', 30.22, -92.02, true),
       ($2, 'Baton Rouge', 'baton-rouge', 'LA', 'America/Chicago', 30.45, -91.19, true),
       ($3, 'Retired', 'retired', 'LA', 'America/Chicago', NULL, NULL, false)`,
      [CITY, OTHER_CITY, INACTIVE_CITY]
    )
    await db.query(
      `INSERT INTO public.tags (id, name, slug, color) VALUES
       ($1, 'Outdoor', 'outdoor', '#222222'), ($2, 'Free', 'free', '#111111')`,
      [TAG_OUTDOOR, TAG_FREE]
    )
    await db.query("INSERT INTO auth.users (id) VALUES ($1), ($2)", [USER_READER, USER_OTHER])
    await db.query(
      `INSERT INTO public.clerk_user_mapping
       (clerk_user_id, supabase_uuid, email, role) VALUES
       ('user_reader', $1, 'reader@example.com', 'member'),
       ('user_other', $2, 'other@example.com', 'member')`,
      [USER_READER, USER_OTHER]
    )
    await db.query(
      `INSERT INTO public.user_profiles (id, email, display_name) VALUES
       ($1, 'reader@example.com', 'Reader'),
       ($2, 'other@example.com', 'Other')`,
      [USER_READER, USER_OTHER]
    )
  })

  afterAll(async () => {
    await app.close()
  })

  async function insertEvent(input: {
    title: string
    description?: string
    start?: string
    cityId?: string
    latitude?: number | null
    longitude?: number | null
    status?: "draft" | "published"
    isFree?: boolean
  }): Promise<string> {
    const id = randomUUID()
    await db.query(
      `INSERT INTO public.events (
         id, title, description, start_datetime, timezone, city_id,
         latitude, longitude, is_free, status
       ) VALUES ($1, $2, $3, $4, 'America/Chicago', $5, $6, $7, $8, $9)`,
      [
        id,
        input.title,
        input.description ?? null,
        input.start ?? "2026-08-16T15:00:00+00:00",
        input.cityId ?? CITY,
        input.latitude ?? null,
        input.longitude ?? null,
        input.isFree ?? true,
        input.status ?? "published",
      ]
    )
    return id
  }

  async function seedEmbedding(eventId: string): Promise<void> {
    await db.query(
      `INSERT INTO public.event_embeddings (event_id, embedding)
       VALUES ($1::uuid, $2::extensions.vector)`,
      [eventId, SIMILAR_VECTOR]
    )
  }

  it("paginates events and accepts the returned next_cursor", async () => {
    const first = await insertEvent({
      title: "First",
      start: "2026-08-16T15:00:00+00:00",
    })
    const second = await insertEvent({
      title: "Second",
      start: "2026-08-16T16:00:00+00:00",
    })

    const page1 = await request(app.getHttpServer())
      .get("/v1/events")
      .query({ limit: 1 })
      .expect(200)
    expect(page1.body.events.map((event: { id: string }) => event.id)).toEqual([first])
    expect(page1.body.next_cursor).toEqual(expect.any(String))

    const page2 = await request(app.getHttpServer())
      .get("/v1/events")
      .query({ limit: 1, cursor: page1.body.next_cursor })
      .expect(200)
    expect(page2.body.events.map((event: { id: string }) => event.id)).toEqual([second])
  })

  it("uses the keyword search path and returns enriched events", async () => {
    const match = await insertEvent({
      title: "Family Storytime",
      description: "at the library",
    })
    await insertEvent({ title: "Farmers Market" })

    const response = await request(app.getHttpServer())
      .get("/v1/events")
      .query({ keyword: "storytime library" })
      .expect(200)

    expect(response.body.events.map((event: { id: string }) => event.id)).toEqual([match])
    expect(response.body.events[0]).toMatchObject({
      avg_rating: "0",
      is_favorited: false,
      tags: [],
    })
  })

  it("returns event detail and 404 for a missing event", async () => {
    const id = await insertEvent({ title: "Detail" })

    const found = await request(app.getHttpServer()).get(`/v1/events/${id}`).expect(200)
    expect(found.body).toMatchObject({ id, title: "Detail" })

    await request(app.getHttpServer()).get(`/v1/events/${randomUUID()}`).expect(404)
  })

  it("personalizes detail for a mapped Clerk identity", async () => {
    const id = await insertEvent({ title: "Favorite" })
    await db.query("INSERT INTO public.favorites (user_id, event_id) VALUES ($1, $2)", [
      USER_READER,
      id,
    ])

    const response = await request(app.getHttpServer())
      .get(`/v1/events/${id}`)
      .set("Authorization", "Bearer mapped-token")
      .expect(200)

    expect(response.body.is_favorited).toBe(true)
    expect(response.body.is_in_calendar).toBe(false)
  })

  it("returns the app's composite detail contract", async () => {
    const id = await insertEvent({ title: "Composite detail" })
    const similar = await insertEvent({ title: "Similar event" })
    await Promise.all([seedEmbedding(id), seedEmbedding(similar)])
    await db.query(
      `INSERT INTO public.comments (user_id, event_id, body, is_approved)
       VALUES ($1, $2, 'Approved comment', true), ($3, $2, 'Hidden comment', false)`,
      [USER_OTHER, id, USER_READER]
    )
    await db.query("INSERT INTO public.ratings (user_id, event_id, score) VALUES ($1, $2, 5)", [
      USER_READER,
      id,
    ])

    const response = await request(app.getHttpServer())
      .get(`/v1/events/${id}/detail`)
      .set("Authorization", "Bearer mapped-token")
      .expect(200)

    expect(response.body).toMatchObject({
      event: { id, title: "Composite detail" },
      similar: [{ event_id: similar, title: "Similar event" }],
      my_rating: 5,
      signed_in: true,
    })
    expect(response.body.comments).toEqual([
      {
        id: expect.any(String),
        body: "Approved comment",
        created_at: expect.any(String),
        updated_at: expect.any(String),
        display_name: "Other",
        avatar_url: null,
      },
    ])
  })

  it("does not leak related user data for an unpublished event", async () => {
    const draft = await insertEvent({ title: "Hidden draft", status: "draft" })
    await db.query(
      `INSERT INTO public.comments (user_id, event_id, body, is_approved)
       VALUES ($1, $2, 'Comment on hidden event', true)`,
      [USER_OTHER, draft]
    )

    const response = await request(app.getHttpServer())
      .get(`/v1/events/${draft}/detail`)
      .set("Authorization", "Bearer mapped-token")
      .expect(200)

    expect(response.body).toEqual({
      event: null,
      similar: [],
      comments: [],
      my_rating: null,
      signed_in: true,
    })
  })

  it("returns up to 200 finite-coordinate map events for the requested city", async () => {
    const mapped = await insertEvent({
      title: "Mapped",
      latitude: 30.22,
      longitude: -92.02,
      isFree: false,
    })
    await insertEvent({ title: "No coordinates" })
    await insertEvent({
      title: "Other city",
      cityId: OTHER_CITY,
      latitude: 30.45,
      longitude: -91.19,
    })

    const response = await request(app.getHttpServer())
      .get("/v1/events/map")
      .query({ city_id: CITY })
      .expect(200)

    expect(response.body).toEqual({
      events: [
        {
          id: mapped,
          title: "Mapped",
          latitude: 30.22,
          longitude: -92.02,
          start_datetime: "2026-08-16 15:00:00+00",
          venue_name: null,
          is_free: false,
        },
      ],
    })
  })

  it("rejects invalid map query parameters", async () => {
    await request(app.getHttpServer())
      .get("/v1/events/map")
      .query({ city_id: "not-a-uuid" })
      .expect(400)
    await request(app.getHttpServer()).get("/v1/events/map").query({ limit: 999 }).expect(400)
  })

  it("returns active cities and tags ordered by slug", async () => {
    const cities = await request(app.getHttpServer()).get("/v1/cities").expect(200)
    expect(cities.body).toEqual([
      expect.objectContaining({ id: OTHER_CITY, name: "Baton Rouge", slug: "baton-rouge" }),
      expect.objectContaining({ id: CITY, name: "Lafayette", slug: "lafayette" }),
    ])

    const tags = await request(app.getHttpServer()).get("/v1/tags").expect(200)
    expect(tags.body).toEqual([
      { id: TAG_FREE, name: "Free", slug: "free", color: "#111111" },
      { id: TAG_OUTDOOR, name: "Outdoor", slug: "outdoor", color: "#222222" },
    ])
  })

  it("rejects a malformed cursor", async () => {
    await request(app.getHttpServer()).get("/v1/events").query({ cursor: "%%%" }).expect(400)
  })

  it("requires a provisioned Clerk identity for favorite and calendar page reads", async () => {
    for (const path of ["/v1/me/favorites", "/v1/me/calendar"]) {
      await request(app.getHttpServer()).get(path).expect(401)
      await request(app.getHttpServer())
        .get(path)
        .set("Authorization", "Bearer unmapped-token")
        .expect(403)
    }
  })

  it("returns only the mapped user's favorite and calendar rows", async () => {
    const mine = await insertEvent({ title: "Mine" })
    const other = await insertEvent({ title: "Other user's event" })
    const draft = await insertEvent({ title: "Hidden favorite", status: "draft" })
    await db.query(
      `INSERT INTO public.favorites (user_id, event_id) VALUES
       ($1, $2), ($1, $3), ($4, $5)`,
      [USER_READER, mine, draft, USER_OTHER, other]
    )
    await db.query(
      `INSERT INTO public.user_calendar_events (user_id, event_id, notes) VALUES
       ($1, $2, 'bring snacks'), ($3, $4, 'private note')`,
      [USER_READER, mine, USER_OTHER, other]
    )

    const server = request(app.getHttpServer())
    const favorites = await server
      .get("/v1/me/favorites")
      .set("Authorization", "Bearer mapped-token")
      .expect(200)
    expect(favorites.body).toEqual({
      events: [expect.objectContaining({ id: mine, title: "Mine", is_favorited: true })],
    })

    const calendar = await server
      .get("/v1/me/calendar")
      .set("Authorization", "Bearer mapped-token")
      .expect(200)
    expect(calendar.body).toEqual({
      entries: [
        expect.objectContaining({
          event_id: mine,
          title: "Mine",
          notes: "bring snacks",
        }),
      ],
    })
  })

  it("requires a provisioned authenticated identity for writes", async () => {
    const eventId = await insertEvent({ title: "Protected" })

    await request(app.getHttpServer())
      .put(`/v1/events/${eventId}/favorite`)
      .send({ on: true })
      .expect(401)
    await request(app.getHttpServer())
      .put(`/v1/events/${eventId}/favorite`)
      .set("Authorization", "Bearer unmapped-token")
      .send({ on: true })
      .expect(403)
  })

  it("toggles favorite and calendar personalization round-trip", async () => {
    const eventId = await insertEvent({ title: "Personalized" })
    const server = request(app.getHttpServer())

    await server
      .put(`/v1/events/${eventId}/favorite`)
      .set("Authorization", "Bearer mapped-token")
      .send({ on: true })
      .expect(200, { ok: true })
    await server
      .put(`/v1/events/${eventId}/calendar`)
      .set("Authorization", "Bearer mapped-token")
      .send({ on: true })
      .expect(200, { ok: true })

    const enabled = await server
      .get(`/v1/events/${eventId}`)
      .set("Authorization", "Bearer mapped-token")
      .expect(200)
    expect(enabled.body).toMatchObject({ is_favorited: true, is_in_calendar: true })

    await server
      .put(`/v1/events/${eventId}/favorite`)
      .set("Authorization", "Bearer mapped-token")
      .send({ on: false })
      .expect(200, { ok: true })
    await server
      .put(`/v1/events/${eventId}/calendar`)
      .set("Authorization", "Bearer mapped-token")
      .send({ on: false })
      .expect(200, { ok: true })

    const disabled = await server
      .get(`/v1/events/${eventId}`)
      .set("Authorization", "Bearer mapped-token")
      .expect(200)
    expect(disabled.body).toMatchObject({ is_favorited: false, is_in_calendar: false })
  })

  it("upserts one rating for the mapped user", async () => {
    const eventId = await insertEvent({ title: "Rate me" })
    const server = request(app.getHttpServer())

    await server
      .put(`/v1/events/${eventId}/rating`)
      .set("Authorization", "Bearer mapped-token")
      .send({ score: 3 })
      .expect(200, { score: 3 })
    await server
      .put(`/v1/events/${eventId}/rating`)
      .set("Authorization", "Bearer mapped-token")
      .send({ score: 5 })
      .expect(200, { score: 5 })

    const rows = await db.query<{ score: number }>(
      "SELECT score FROM public.ratings WHERE user_id = $1 AND event_id = $2",
      [USER_READER, eventId]
    )
    expect(rows).toEqual([{ score: 5 }])
  })

  it("posts comments and only removes the owner's comment", async () => {
    const eventId = await insertEvent({ title: "Discuss me" })
    const server = request(app.getHttpServer())
    const posted = await server
      .post(`/v1/events/${eventId}/comments`)
      .set("Authorization", "Bearer mapped-token")
      .send({ body: "  Great event  " })
      .expect(201)

    expect(posted.body.id).toEqual(expect.any(String))
    await server
      .delete(`/v1/comments/${posted.body.id}`)
      .set("Authorization", "Bearer other-token")
      .expect(200, { removed: false })
    await server
      .delete(`/v1/comments/${posted.body.id}`)
      .set("Authorization", "Bearer mapped-token")
      .expect(200, { removed: true })
  })

  it("inserts draft submissions and rejects the sixth in 24 hours", async () => {
    const server = request(app.getHttpServer())
    const submit = (number: number) =>
      server
        .post("/v1/events")
        .set("Authorization", "Bearer mapped-token")
        .send({
          title: `Community Event ${number}`,
          description: "Bring a blanket",
          startDatetime: "2026-08-19T15:00:00+00:00",
          cityId: CITY,
        })

    const first = await submit(1).expect(201)
    for (let number = 2; number <= 5; number++) {
      await submit(number).expect(201)
    }
    await submit(6).expect(429)

    const [row] = await db.query<{
      id: string
      status: string
      source_name: string
      submitted_by: string
    }>(
      `SELECT id::text, status::text, source_name, submitted_by::text
       FROM public.events WHERE id = $1`,
      [first.body.id]
    )
    expect(row).toEqual({
      id: first.body.id,
      status: "draft",
      source_name: "community",
      submitted_by: USER_READER,
    })
  })

  it("sets, flips, and gets preferred cities by demoting the old primary first", async () => {
    const server = request(app.getHttpServer())

    await server
      .put("/v1/me/preferred-cities")
      .set("Authorization", "Bearer mapped-token")
      .send({ city_ids: [CITY, OTHER_CITY], primary_city_id: CITY })
      .expect(200, { ok: true })
    await server
      .put("/v1/me/preferred-cities")
      .set("Authorization", "Bearer mapped-token")
      .send({ city_ids: [CITY, OTHER_CITY], primary_city_id: OTHER_CITY })
      .expect(200, { ok: true })

    const response = await server
      .get("/v1/me/preferred-cities")
      .set("Authorization", "Bearer mapped-token")
      .expect(200)
    expect(response.body).toHaveLength(2)
    expect(response.body.filter((city: { is_primary: boolean }) => city.is_primary)).toEqual([
      expect.objectContaining({ city_id: OTHER_CITY }),
    ])
  })

  it("requires a mapped Clerk session for GET /v1/plan", async () => {
    await request(app.getHttpServer()).get("/v1/plan").expect(401)
    await request(app.getHttpServer())
      .get("/v1/plan")
      .set("Authorization", "Bearer unmapped-token")
      .expect(403)
  })

  it("returns today's plan for a mapped identity", async () => {
    const start = new Date(Date.now() + 3_600_000).toISOString()
    const id = await insertEvent({ title: "Tonight", start })

    const response = await request(app.getHttpServer())
      .get("/v1/plan")
      .query({ city_id: CITY, kid_age: 5 })
      .set("Authorization", "Bearer mapped-token")
      .expect(200)

    expect(response.body.available).toBe(true)
    expect(response.body.planned.map((row: { event_id: string }) => row.event_id)).toEqual([id])
    expect(response.body.planned[0]).toMatchObject({
      event_id: id,
      title: "Tonight",
      city_id: CITY,
    })
  })

  it("rejects an invalid plan city_id", async () => {
    await request(app.getHttpServer())
      .get("/v1/plan")
      .query({ city_id: "not-a-uuid" })
      .set("Authorization", "Bearer mapped-token")
      .expect(400)
  })
})
