import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { EventsRepository } from "../../src/data/events.repository.js"
import { ReferenceRepository } from "../../src/data/reference.repository.js"
import type { DbService } from "../../src/db/db.service.js"
import { createIntegrationDb } from "./db.js"
import { ensureCatalogSchema, ensureConsumerSimilaritySchema, truncateCatalog } from "./catalog.js"

const CITY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const OTHER_CITY = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const TAG_FREE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
const TAG_OUTDOOR = "ffffffff-ffff-4fff-8fff-ffffffffffff"
const USER = "99999999-9999-4999-8999-999999999999"
const SIMILAR_VECTOR = `[1,${Array<number>(1535).fill(0).join(",")}]`

describe("U23 data layer (integration, real RPCs)", () => {
  let db: DbService
  let events: EventsRepository
  let reference: ReferenceRepository

  beforeAll(async () => {
    db = createIntegrationDb()
    await ensureCatalogSchema(db)
    await ensureConsumerSimilaritySchema(db)
    events = new EventsRepository(db)
    reference = new ReferenceRepository(db)
  })

  beforeEach(async () => {
    await truncateCatalog(db)
    await db.query(
      `INSERT INTO public.cities (id, name, slug, state, timezone, latitude, longitude, is_active) VALUES
       ($1, 'Lafayette', 'lafayette', 'LA', 'America/Chicago', 30.22, -92.02, true),
       ($2, 'Retired', 'retired', 'LA', 'America/Chicago', NULL, NULL, false)`,
      [CITY, OTHER_CITY]
    )
    await db.query(
      `INSERT INTO public.tags (id, name, slug, color) VALUES
       ($1, 'Free', 'free', '#111111'), ($2, 'Outdoor', 'outdoor', '#222222')`,
      [TAG_FREE, TAG_OUTDOOR]
    )
  })

  afterAll(async () => {
    await db.onModuleDestroy()
  })

  async function insertEvent(input: {
    title: string
    description?: string
    status?: string
    start?: string
    cityId?: string
    isFree?: boolean
    lat?: number
    lng?: number
    ageMin?: number
    ageMax?: number
    tagIds?: string[]
  }): Promise<string> {
    const id = randomUUID()
    await db.query(
      `INSERT INTO public.events (
         id, title, description, start_datetime, timezone, city_id, latitude, longitude,
         age_min, age_max, is_free, status
       ) VALUES ($1, $2, $3, $4, 'America/Chicago', $5, $6, $7, $8, $9, $10, $11::public.event_status)`,
      [
        id,
        input.title,
        input.description ?? null,
        input.start ?? "2026-08-16T15:00:00+00:00",
        input.cityId ?? CITY,
        input.lat ?? null,
        input.lng ?? null,
        input.ageMin ?? null,
        input.ageMax ?? null,
        input.isFree ?? true,
        input.status ?? "published",
      ]
    )
    for (const tagId of input.tagIds ?? []) {
      await db.query("INSERT INTO public.event_tags (event_id, tag_id) VALUES ($1, $2)", [
        id,
        tagId,
      ])
    }
    return id
  }

  describe("listEvents (events_enriched)", () => {
    it("returns published rows with enrichment defaults and hides drafts", async () => {
      const id = await insertEvent({ title: "Storytime" })
      await insertEvent({ title: "Hidden", status: "draft" })
      const rows = await events.listEvents()
      expect(rows.map((row) => row.id)).toEqual([id])
      const row = rows[0]!
      expect(row.avg_rating).toBe("0")
      expect(row.rating_count).toBe(0)
      expect(row.tags).toEqual([])
      expect(row.is_favorited).toBe(false)
      expect(row.is_in_calendar).toBe(false)
      expect(typeof row.start_datetime).toBe("string")
      expect(row).not.toHaveProperty("search_vector")
    })

    it("aggregates ratings and tags into the enriched row", async () => {
      const id = await insertEvent({ title: "Rated", tagIds: [TAG_FREE, TAG_OUTDOOR] })
      await db.query(
        "INSERT INTO public.ratings (user_id, event_id, score) VALUES ($1, $2, 4), ($3, $2, 5)",
        [USER, id, randomUUID()]
      )
      const [row] = await events.listEvents()
      expect(row).toBeDefined()
      expect(row!.avg_rating).toBe("4.5")
      expect(row!.rating_count).toBe(2)
      expect((row!.tags as { slug: string }[]).map((tag) => tag.slug)).toEqual(["free", "outdoor"])
    })

    it("personalizes is_favorited / is_in_calendar for the storage user key", async () => {
      const id = await insertEvent({ title: "Mine" })
      await db.query("INSERT INTO public.favorites (user_id, event_id) VALUES ($1, $2)", [USER, id])
      await db.query(
        "INSERT INTO public.user_calendar_events (user_id, event_id) VALUES ($1, $2)",
        [USER, id]
      )
      const [personalized] = await events.listEvents({ userKey: USER })
      expect(personalized?.is_favorited).toBe(true)
      expect(personalized?.is_in_calendar).toBe(true)
      const [anonymous] = await events.listEvents()
      expect(anonymous?.is_favorited).toBe(false)
    })

    it("keyset-paginates in (start_datetime, id) order with page size 24 default", async () => {
      const first = await insertEvent({ title: "A", start: "2026-08-16T15:00:00+00:00" })
      const second = await insertEvent({ title: "B", start: "2026-08-16T16:00:00+00:00" })
      const page1 = await events.listEvents({ limit: 1 })
      expect(page1.map((row) => row.id)).toEqual([first])
      const last = page1[0]!
      const page2 = await events.listEvents({
        limit: 1,
        after: { startDatetime: last.start_datetime, id: last.id },
      })
      expect(page2.map((row) => row.id)).toEqual([second])
    })

    it("hydrates specific event ids regardless of paging (favorites page path)", async () => {
      const a = await insertEvent({ title: "A" })
      const b = await insertEvent({ title: "B" })
      const draft = await insertEvent({ title: "Draft", status: "draft" })
      const rows = await events.listEvents({ eventIds: [a, b, draft] })
      expect(rows.map((row) => row.id).toSorted()).toEqual([a, b].toSorted())
    })
  })

  describe("searchEvents (search_events)", () => {
    it("matches keywords via full-text search", async () => {
      const id = await insertEvent({ title: "Family Storytime", description: "at the library" })
      await insertEvent({ title: "Farmers Market" })
      const rows = await events.searchEvents({ keyword: "storytime library" })
      expect(rows.map((row) => row.id)).toEqual([id])
    })

    it("applies age-overlap semantics (bounds only penalize when violated)", async () => {
      const toddler = await insertEvent({ title: "Toddler time", ageMin: 1, ageMax: 3 })
      await insertEvent({ title: "Teens only", ageMin: 13, ageMax: 17 })
      const unbounded = await insertEvent({ title: "All ages" })
      const rows = await events.searchEvents({ ageMin: 2, ageMax: 4 })
      expect(rows.map((row) => row.id).toSorted()).toEqual([toddler, unbounded].toSorted())
    })

    it("filters by radius using earth_distance when lat/lng/radius are all present", async () => {
      const near = await insertEvent({ title: "Near", lat: 30.22, lng: -92.02 })
      await insertEvent({ title: "Far", lat: 31.5, lng: -95.0 })
      await insertEvent({ title: "No coords" })
      const rows = await events.searchEvents({ lat: 30.22, lng: -92.02, radiusKm: 25 })
      expect(rows.map((row) => row.id)).toEqual([near])
    })

    it("requires every tag slug (AND semantics)", async () => {
      const both = await insertEvent({ title: "Both", tagIds: [TAG_FREE, TAG_OUTDOOR] })
      await insertEvent({ title: "One", tagIds: [TAG_OUTDOOR] })
      const rows = await events.searchEvents({ tagSlugs: ["free", "outdoor"] })
      expect(rows.map((row) => row.id)).toEqual([both])
    })
  })

  describe("findSimilarEventsById", () => {
    async function seedEmbedding(eventId: string): Promise<void> {
      await db.query(
        `INSERT INTO public.event_embeddings (event_id, embedding)
         VALUES ($1::uuid, $2::extensions.vector)`,
        [eventId, SIMILAR_VECTOR]
      )
    }

    it("returns only published neighbors for a published source", async () => {
      const source = await insertEvent({ title: "Source" })
      const published = await insertEvent({ title: "Published neighbor" })
      const draft = await insertEvent({ title: "Draft neighbor", status: "draft" })
      await Promise.all([seedEmbedding(source), seedEmbedding(published), seedEmbedding(draft)])

      await expect(events.findSimilarEventsById(source, { limit: 4 })).resolves.toEqual([
        { event_id: published, title: "Published neighbor" },
      ])
    })

    it("returns no neighbors when the source event is unpublished", async () => {
      const source = await insertEvent({ title: "Draft source", status: "draft" })
      const published = await insertEvent({ title: "Published neighbor" })
      await Promise.all([seedEmbedding(source), seedEmbedding(published)])

      await expect(events.findSimilarEventsById(source, { limit: 4 })).resolves.toEqual([])
    })
  })

  describe("wire-shape parity", () => {
    // Full key-set assertions: if the deployed RPC or the projection drifts
    // from the contract in src/data/types.ts, these fail before any consumer does.
    const ENRICHED_KEYS = [
      "id",
      "title",
      "description",
      "start_datetime",
      "end_datetime",
      "timezone",
      "venue_name",
      "address",
      "city_id",
      "latitude",
      "longitude",
      "age_min",
      "age_max",
      "price",
      "is_free",
      "source_url",
      "source_name",
      "images",
      "status",
      "recurrence_info",
      "is_featured",
      "view_count",
      "created_at",
      "updated_at",
      "avg_rating",
      "rating_count",
      "tags",
      "is_favorited",
      "is_in_calendar",
    ].toSorted()

    const SEARCHED_KEYS = [
      "id",
      "title",
      "description",
      "start_datetime",
      "end_datetime",
      "venue_name",
      "address",
      "city_id",
      "latitude",
      "longitude",
      "age_min",
      "age_max",
      "price",
      "is_free",
      "images",
      "status",
      "is_featured",
    ].toSorted()

    it("EnrichedEvent rows carry exactly the contract keys", async () => {
      await insertEvent({ title: "Shape" })
      const [row] = await events.listEvents()
      expect(Object.keys(row!).toSorted()).toEqual(ENRICHED_KEYS)
    })

    it("SearchedEvent rows carry exactly the contract keys", async () => {
      await insertEvent({ title: "Shape" })
      const [row] = await events.searchEvents()
      expect(Object.keys(row!).toSorted()).toEqual(SEARCHED_KEYS)
    })
  })

  describe("listCities", () => {
    it("returns only active cities with numeric columns as text", async () => {
      const cities = await reference.listCities()
      expect(cities.map((city) => city.slug)).toEqual(["lafayette"])
      expect(cities[0]?.latitude).toBe("30.22")
      expect(cities[0]?.timezone).toBe("America/Chicago")
    })
  })
})
