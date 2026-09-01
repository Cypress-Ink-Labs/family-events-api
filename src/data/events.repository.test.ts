import { describe, expect, it, vi } from "vitest"

import type { DbService } from "../db/db.service.js"
import { EventsRepository } from "./events.repository.js"
import { ReferenceRepository } from "./reference.repository.js"

function makeDb() {
  const query = vi.fn<(text: string, params?: unknown[]) => Promise<unknown[]>>(async () => [])
  return { db: { query } as unknown as DbService, query }
}

describe("EventsRepository.listEvents", () => {
  it("calls events_enriched with named parameters and the app's defaults", async () => {
    const { db, query } = makeDb()
    await new EventsRepository(db).listEvents()
    const [sql, params] = query.mock.calls[0]!
    expect(sql).toContain("public.events_enriched(")
    expect(sql).toContain("p_after_start_datetime => $7::timestamptz")
    expect(params).toEqual([null, "published", null, null, null, null, null, null, 24])
  })

  it("threads the keyset cursor and user key through", async () => {
    const { db, query } = makeDb()
    await new EventsRepository(db).listEvents({
      cityId: "c-1",
      userKey: "u-1",
      after: { startDatetime: "2026-08-16T15:00:00.123456+00:00", id: "e-1" },
      limit: 10,
    })
    expect(query.mock.calls[0]?.[1]).toEqual([
      "c-1",
      "published",
      "u-1",
      null,
      null,
      null,
      "2026-08-16T15:00:00.123456+00:00",
      "e-1",
      10,
    ])
  })

  it("selects only the contract columns (no search_vector leak)", async () => {
    const { db, query } = makeDb()
    await new EventsRepository(db).listEvents()
    expect(query.mock.calls[0]?.[0]).not.toContain("SELECT *")
    expect(query.mock.calls[0]?.[0]).not.toContain("search_vector")
  })

  it("re-applies the requested status after event-id hydration", async () => {
    const { db, query } = makeDb()
    await new EventsRepository(db).listEvents({ eventIds: ["event-1"] })
    expect(query.mock.calls[0]?.[0]).toContain("WHERE status = $2::text")
  })
})

describe("EventsRepository.listMapEvents", () => {
  it("filters usable coordinates before applying the map limit", async () => {
    const { db, query } = makeDb()
    await new EventsRepository(db).listMapEvents({ cityId: "city-1", limit: 200 })
    const [sql, params] = query.mock.calls[0]!
    expect(sql.indexOf("latitude IS NOT NULL")).toBeLessThan(sql.indexOf("LIMIT"))
    expect(sql.indexOf("longitude IS NOT NULL")).toBeLessThan(sql.indexOf("LIMIT"))
    expect(sql).toContain("latitude BETWEEN -90 AND 90")
    expect(sql).toContain("longitude BETWEEN -180 AND 180")
    expect(params).toEqual(["city-1", 200])
  })
})

describe("EventsRepository.searchEvents", () => {
  it("calls search_events with named parameters and the app's defaults", async () => {
    const { db, query } = makeDb()
    await new EventsRepository(db).searchEvents({ keyword: "storytime" })
    const [sql, params] = query.mock.calls[0]!
    expect(sql).toContain("public.search_events(")
    expect(sql).toContain("p_radius_km            => $15::double precision")
    expect(params).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      "storytime",
      24,
      null,
      null,
      null,
      null,
      null,
    ])
  })
})

describe("EventsRepository.findSimilarEventsById", () => {
  it("calls the consumer similarity RPC with parameterized inputs", async () => {
    const { db, query } = makeDb()

    await new EventsRepository(db).findSimilarEventsById("event-1", {
      limit: 4,
      cityId: "city-1",
    })

    const [sql, params] = query.mock.calls[0]!
    expect(sql).toContain("public.find_similar_events_by_id(")
    expect(sql).not.toContain("SELECT *")
    expect(params).toEqual(["event-1", 4, "city-1"])
  })
})

describe("binding order (sentinel values)", () => {
  // Every input field gets a distinct sentinel so a swapped positional bind
  // fails loudly, without asserting SQL text.
  it("listEvents binds each input to its RPC parameter position", async () => {
    const { db, query } = makeDb()
    await new EventsRepository(db).listEvents({
      cityId: "city",
      status: "draft",
      userKey: "user",
      eventIds: ["e1", "e2"],
      dateFrom: "from",
      dateTo: "to",
      after: { startDatetime: "after-start", id: "after-id" },
      limit: 7,
    })
    expect(query.mock.calls[0]?.[1]).toEqual([
      "city",
      "draft",
      "user",
      ["e1", "e2"],
      "from",
      "to",
      "after-start",
      "after-id",
      7,
    ])
  })

  it("searchEvents binds each input to its RPC parameter position", async () => {
    const { db, query } = makeDb()
    await new EventsRepository(db).searchEvents({
      cityId: "city",
      dateFrom: "from",
      dateTo: "to",
      ageMin: 1,
      ageMax: 2,
      isFree: true,
      isFeatured: false,
      tagSlugs: ["a", "b"],
      keyword: "kw",
      limit: 9,
      after: { startDatetime: "after-start", id: "after-id" },
      lat: 30.1,
      lng: -92.2,
      radiusKm: 25,
    })
    expect(query.mock.calls[0]?.[1]).toEqual([
      "city",
      "from",
      "to",
      1,
      2,
      true,
      false,
      ["a", "b"],
      "kw",
      9,
      "after-start",
      "after-id",
      30.1,
      -92.2,
      25,
    ])
  })
})

describe("ReferenceRepository.listCities", () => {
  it("lists only active cities in name order", async () => {
    const { db, query } = makeDb()
    await new ReferenceRepository(db).listCities()
    const [sql] = query.mock.calls[0]!
    expect(sql).toContain("is_active = true")
    expect(sql).toContain("ORDER BY name ASC")
  })
})

describe("ReferenceRepository.listTags", () => {
  it("selects the public tag contract in slug order", async () => {
    const { db, query } = makeDb()
    await new ReferenceRepository(db).listTags()
    const [sql] = query.mock.calls[0]!
    expect(sql).toContain("SELECT id::text, name, slug, color")
    expect(sql).toContain("ORDER BY slug ASC")
  })
})
