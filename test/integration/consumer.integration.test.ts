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
import { ensureCatalogSchema, truncateCatalog } from "./catalog.js"
import { integrationDatabaseUrl } from "./db.js"

vi.mock("@clerk/backend", () => ({
  verifyToken: vi.fn(async (token: string) => {
    if (token === "mapped-token") return { sub: "user_reader" }
    if (token === "unmapped-token") return { sub: "user_unmapped" }
    throw new Error("bad token")
  }),
}))

const CITY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const INACTIVE_CITY = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const TAG_FREE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
const TAG_OUTDOOR = "ffffffff-ffff-4fff-8fff-ffffffffffff"

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
       ($2, 'Retired', 'retired', 'LA', 'America/Chicago', NULL, NULL, false)`,
      [CITY, INACTIVE_CITY]
    )
    await db.query(
      `INSERT INTO public.tags (id, name, slug, color) VALUES
       ($1, 'Outdoor', 'outdoor', '#222222'), ($2, 'Free', 'free', '#111111')`,
      [TAG_OUTDOOR, TAG_FREE]
    )
  })

  afterAll(async () => {
    await app.close()
  })

  async function insertEvent(input: {
    title: string
    description?: string
    start?: string
  }): Promise<string> {
    const id = randomUUID()
    await db.query(
      `INSERT INTO public.events (
         id, title, description, start_datetime, timezone, city_id, is_free, status
       ) VALUES ($1, $2, $3, $4, 'America/Chicago', $5, true, 'published')`,
      [id, input.title, input.description ?? null, input.start ?? "2026-08-16T15:00:00+00:00", CITY]
    )
    return id
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
    const userId = randomUUID()
    await db.query("INSERT INTO auth.users (id) VALUES ($1)", [userId])
    await db.query(
      `INSERT INTO public.clerk_user_mapping
       (clerk_user_id, supabase_uuid, email, role)
       VALUES ('user_reader', $1, 'reader@example.com', 'member')`,
      [userId]
    )
    await db.query("INSERT INTO public.favorites (user_id, event_id) VALUES ($1, $2)", [userId, id])

    const response = await request(app.getHttpServer())
      .get(`/v1/events/${id}`)
      .set("Authorization", "Bearer mapped-token")
      .expect(200)

    expect(response.body.is_favorited).toBe(true)
    expect(response.body.is_in_calendar).toBe(false)
  })

  it("returns active cities and tags ordered by slug", async () => {
    const cities = await request(app.getHttpServer()).get("/v1/cities").expect(200)
    expect(cities.body).toEqual([
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
})
