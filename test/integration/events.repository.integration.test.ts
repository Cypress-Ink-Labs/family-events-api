import { randomUUID } from "node:crypto"

import { ConfigService } from "@nestjs/config"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { decodeEventCursor } from "../../src/data/cursor.js"
import { EventsRepository } from "../../src/data/events.repository.js"
import { DbService } from "../../src/db/db.service.js"
import { ensureCatalogSchema, truncateCatalog } from "./catalog.js"

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres"

const CITY_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const OTHER_CITY = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const TAG_FREE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
const TAG_OUTDOOR = "ffffffff-ffff-4fff-8fff-ffffffffffff"

describe("EventsRepository (integration)", () => {
  let db: DbService
  let events: EventsRepository

  beforeAll(async () => {
    db = new DbService(new ConfigService({ DATABASE_URL }) as unknown as ConfigService<never, true>)
    await ensureCatalogSchema(db)
    events = new EventsRepository(db)
  })

  beforeEach(async () => {
    await truncateCatalog(db)
    await db.query(
      `INSERT INTO public.cities (id, name, slug, timezone) VALUES
       ($1, 'Lafayette', 'lafayette', 'America/Chicago'),
       ($2, 'Baton Rouge', 'baton-rouge', 'America/Chicago')`,
      [CITY_ID, OTHER_CITY]
    )
    await db.query(
      `INSERT INTO public.tags (id, name, slug, color) VALUES
       ($1, 'Free', 'free', '#111111'),
       ($2, 'Outdoor', 'outdoor', '#222222')`,
      [TAG_FREE, TAG_OUTDOOR]
    )
  })

  afterAll(async () => {
    await db.onModuleDestroy()
  })

  async function insertEvent(input: {
    title: string
    status?: "draft" | "published"
    cityId?: string
    start?: string
    isFree?: boolean
    description?: string
    tagIds?: string[]
  }): Promise<string> {
    const id = randomUUID()
    await db.query(
      `INSERT INTO public.events (
         id, title, description, start_datetime, timezone, city_id, is_free, status
       ) VALUES ($1, $2, $3, $4, 'America/Chicago', $5, $6, $7)`,
      [
        id,
        input.title,
        input.description ?? null,
        input.start ?? "2026-08-16T15:00:00+00:00",
        input.cityId ?? CITY_ID,
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

  it("hides draft and unpublished rows", async () => {
    const publishedId = await insertEvent({ title: "Visible" })
    await insertEvent({ title: "Hidden", status: "draft" })
    const listed = await events.listPublished({ limit: 20 })
    expect(listed.items.map((item) => item.id)).toEqual([publishedId])
    expect(await events.findPublishedById(publishedId)).not.toBeNull()
  })

  it("filters by city, free flag, date window, and tag AND", async () => {
    const match = await insertEvent({
      title: "Park picnic",
      isFree: true,
      start: "2026-08-16T16:00:00+00:00",
      tagIds: [TAG_FREE, TAG_OUTDOOR],
    })
    await insertEvent({
      title: "Paid concert",
      isFree: false,
      start: "2026-08-16T16:30:00+00:00",
      tagIds: [TAG_OUTDOOR],
    })
    await insertEvent({
      title: "Other city",
      cityId: OTHER_CITY,
      start: "2026-08-16T17:00:00+00:00",
      tagIds: [TAG_FREE, TAG_OUTDOOR],
    })
    const listed = await events.listPublished({
      limit: 20,
      cityId: CITY_ID,
      isFree: true,
      dateFrom: "2026-08-16T00:00:00+00:00",
      dateTo: "2026-08-17T00:00:00+00:00",
      tagSlugs: ["free", "outdoor"],
    })
    expect(listed.items.map((item) => item.id)).toEqual([match])
    expect(listed.items[0]?.tags.map((tag) => tag.slug)).toEqual(["free", "outdoor"])
  })

  it("matches keyword against title with LIKE metacharacters escaped", async () => {
    await insertEvent({ title: "100% fun day" })
    await insertEvent({ title: "100X fun day" })
    const listed = await events.listPublished({ limit: 20, keyword: "100%" })
    expect(listed.items.map((item) => item.title)).toEqual(["100% fun day"])
  })

  it("keyset-paginates in start_datetime, id order", async () => {
    const first = await insertEvent({ title: "A", start: "2026-08-16T15:00:00+00:00" })
    const second = await insertEvent({ title: "B", start: "2026-08-16T16:00:00+00:00" })
    const page1 = await events.listPublished({ limit: 1 })
    expect(page1.items[0]?.id).toBe(first)
    const cursor = decodeEventCursor(page1.nextCursor ?? "")
    expect(cursor).not.toBeNull()
    const page2 = await events.listPublished({ limit: 1, cursor })
    expect(page2.items[0]?.id).toBe(second)
    expect(page2.nextCursor).toBeNull()
  })

  it("round-trips start_datetime as text per the U6 convention", async () => {
    const id = await insertEvent({ title: "Clock", start: "2026-08-16T15:00:00.123456+00:00" })
    const event = await events.findPublishedById(id)
    expect(typeof event?.startDatetime).toBe("string")
    expect(event?.startDatetime).toContain("2026-08-16")
  })
})
