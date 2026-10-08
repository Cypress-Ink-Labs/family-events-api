import { randomUUID } from "node:crypto"
import type { INestApplication } from "@nestjs/common"
import { ConfigModule } from "@nestjs/config"
import { Test } from "@nestjs/testing"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { DbModule } from "../../src/db/db.module.js"
import { DbService } from "../../src/db/db.service.js"
import { PublicExportsModule } from "../../src/public-exports/public-exports.module.js"
import { ensureCatalogSchema, truncateCatalog } from "./catalog.js"
import { integrationDatabaseUrl } from "./db.js"

describe("public export HTTP boundaries", () => {
  let app: INestApplication
  let db: DbService
  const city = randomUUID()
  const otherCity = randomUUID()
  let published: string
  let hidden: string

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ DATABASE_URL: integrationDatabaseUrl() })],
        }),
        DbModule,
        PublicExportsModule,
      ],
    }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
    db = app.get(DbService)
    await ensureCatalogSchema(db)
  })
  afterAll(async () => {
    await app?.close()
  })
  beforeEach(async () => {
    await truncateCatalog(db)
    await db.query(
      "INSERT INTO public.cities(id,name,slug,timezone) VALUES($1,'City','city','America/Chicago'),($2,'Other','other','UTC')",
      [city, otherCity]
    )
    published = await insert(
      "Library story",
      "published",
      city,
      "2099-11-01 06:30:00.123456+00",
      true
    )
    hidden = await insert("Private draft", "draft", city)
    await insert("Other city", "published", otherCity)
    await insert("Past event", "published", city, "2000-01-01T00:00:00Z")
    const tag = randomUUID()
    await db.query("INSERT INTO public.tags(id,name,slug) VALUES($1,'Story','story')", [tag])
    await db.query("INSERT INTO public.event_tags(event_id,tag_id) VALUES($1,$2)", [published, tag])
  })
  async function insert(
    title: string,
    status: string,
    cityId: string,
    start = "2099-11-02T00:00:00Z",
    free = false
  ) {
    const id = randomUUID()
    await db.query(
      "INSERT INTO public.events(id,title,status,city_id,start_datetime,is_free,price,latitude,longitude,images) VALUES($1,$2,$3::public.event_status,$4,$5,$6,12.50,30.22,-92.02,'[\"https://images.example.test/story.png\"]')",
      [id, title, status, cityId, start, free]
    )
    return id
  }
  it("preserves legacy city/date/free/tag/keyword filters and public projection", async () => {
    const response = await request(app.getHttpServer())
      .get("/v1/public-events")
      .query({
        city_id: city,
        date_from: "2099-01-01T00:00:00Z",
        date_to: "2100-01-01T00:00:00Z",
        is_free: "true",
        tags: "story",
        keyword: "Library",
      })
      .expect(200)
    expect(response.body.data).toHaveLength(1)
    expect(response.body.data[0]).toMatchObject({
      id: published,
      price: 12.5,
      latitude: 30.22,
      longitude: -92.02,
      timezone: null,
      is_outdoor: null,
    })
    expect(response.body.data[0]).not.toHaveProperty("submitted_by")
    expect(response.body.data[0]).not.toHaveProperty("llm_review_status")
    expect(response.body.data[0]).not.toHaveProperty("is_favorited")
    expect(response.body).not.toHaveProperty("next_cursor")
  })
  it("keeps keyset microseconds and excludes private events across pages", async () => {
    await insert("One microsecond later", "published", city, "2099-11-01 06:30:00.123457+00")
    const first = await request(app.getHttpServer())
      .get("/v1/public-events")
      .query({ date_from: "2099-01-01T00:00:00Z", limit: "1" })
      .expect(200)
    expect(first.body.data[0].id).toBe(published)
    expect(
      JSON.parse(Buffer.from(first.body.next_cursor, "base64").toString()).after_start
    ).toContain(".123456")
    const second = await request(app.getHttpServer())
      .get("/v1/public-events")
      .query({ date_from: "2099-01-01T00:00:00Z", limit: "1", cursor: first.body.next_cursor })
      .expect(200)
    expect(second.body.data[0].title).toBe("One microsecond later")
    const all = await request(app.getHttpServer()).get("/v1/public-events").expect(200)
    expect(all.body.data.map((event: { id: string }) => event.id)).not.toContain(hidden)
  })
  it("conceals single drafts and returns the exact legacy single-event envelope", async () => {
    await request(app.getHttpServer()).get(`/v1/public-events/${hidden}`).expect(404)
    await request(app.getHttpServer()).get(`/v1/public-events/${randomUUID()}`).expect(404)
    const response = await request(app.getHttpServer())
      .get(`/v1/public-events/${published}`)
      .expect(200)
    expect(response.body.data.id).toBe(published)
    expect(Object.keys(response.body)).toEqual(["data"])
  })
  it("feed exports only upcoming published events and filters cities", async () => {
    const response = await request(app.getHttpServer())
      .get("/v1/public-exports/feed")
      .query({ city })
      .expect(200)
    expect(response.body.map((event: { id: string }) => event.id)).toEqual([published])
  })
  it("sitemap includes past and upcoming public events in descending order", async () => {
    const response = await request(app.getHttpServer())
      .get("/v1/public-exports/sitemap")
      .expect(200)
    expect(response.body).toHaveLength(3)
    expect(response.body.map((event: { id: string }) => event.id)).not.toContain(hidden)
    expect(Object.keys(response.body[0]).toSorted()).toEqual(["id", "start_datetime"])
  })
  it("rejects malformed parameters and repeated query values before DB work", async () => {
    for (const query of [
      { limit: "0" },
      { limit: "101" },
      { limit: "01" },
      { city_id: "bad" },
      { is_free: "yes" },
      { tags: "INVALID" },
      { tags: Array(11).fill("story").join(",") },
      { keyword: "x".repeat(101) },
      { cursor: "bad" },
      { date_from: "bad" },
    ]) {
      await request(app.getHttpServer()).get("/v1/public-events").query(query).expect(400)
    }
    await request(app.getHttpServer()).get("/v1/public-events?limit=1&limit=2").expect(400)
    await request(app.getHttpServer()).get("/v1/public-exports/feed?city=bad").expect(400)
  })
  it("enforces feed 200 and sitemap 5000 limits in PostgreSQL", async () => {
    await db.query(
      "INSERT INTO public.events(id,title,status,city_id,start_datetime) SELECT gen_random_uuid(),'Bulk event','published',$1,'2099-12-01'::timestamptz + n * interval '1 second' FROM generate_series(1,5002) n",
      [city]
    )
    const feed = await request(app.getHttpServer()).get("/v1/public-exports/feed").expect(200)
    const sitemap = await request(app.getHttpServer()).get("/v1/public-exports/sitemap").expect(200)
    expect(feed.body).toHaveLength(200)
    expect(sitemap.body).toHaveLength(5000)
  })
})
