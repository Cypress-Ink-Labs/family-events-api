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
    expect(query.mock.calls[0]?.[0]).toContain("source_details_fetched_at")
  })

  it("re-applies the requested status after event-id hydration", async () => {
    const { db, query } = makeDb()
    await new EventsRepository(db).listEvents({ eventIds: ["event-1"] })
    expect(query.mock.calls[0]?.[0]).toContain("WHERE status = $2::text")
  })
})

describe("EventsRepository.listMapEvents", () => {
  it("uses the same local range and ended-event predicates as Explore", async () => {
    const { db, query } = makeDb()
    await new EventsRepository(db).listMapEvents({
      cityId: "city-1",
      range: "weekend",
      now: "2026-08-16T15:00:00Z",
      ages: [],
      ageMode: "all",
      includeUnknownAge: false,
    })
    const [sql, params] = query.mock.calls[0]!
    expect(sql).toContain("AT TIME ZONE z.zone")
    expect(sql).toContain("e.end_datetime IS NULL AND e.start_datetime >= $3")
    expect(params).toEqual(["city-1", "weekend", "2026-08-16T15:00:00Z", [], "all", false, "any"])
  })

  it("applies the shared tri-state age predicate before map ordering", async () => {
    const { db, query } = makeDb()
    await new EventsRepository(db).listMapEvents({
      range: "weekend",
      now: "2026-08-16T15:00:00Z",
      ages: [2, 7],
      ageMode: "any",
      includeUnknownAge: true,
    })
    const [sql, params] = query.mock.calls[0]!
    expect(sql.indexOf("age_min IS NOT NULL AND age_max IS NOT NULL")).toBeLessThan(
      sql.indexOf("ORDER BY")
    )
    expect(sql).toContain("age < age_min")
    expect(sql).toContain("age > age_max")
    expect(sql).toContain("AS age_match")
    expect(params).toEqual([null, "weekend", "2026-08-16T15:00:00Z", [2, 7], "any", true, "any"])
  })

  it("counts every invalid coordinate before transferring at most 200 valid rows", async () => {
    const { db, query } = makeDb()
    await new EventsRepository(db).listMapEvents({
      range: "upcoming",
      now: "2026-08-16T15:00:00Z",
      ages: [],
      ageMode: "all",
      includeUnknownAge: false,
    })
    const sql = query.mock.calls[0]![0]
    expect(sql).toContain("WITH matching AS MATERIALIZED")
    expect(sql).toContain("count(*) FILTER")
    expect(sql).toContain("latitude NOT BETWEEN -90 AND 90")
    expect(sql.indexOf("admission_cost_state")).toBeLessThan(sql.indexOf("coordinate_counts"))
    expect(sql.indexOf("LIMIT 200")).toBeLessThan(sql.indexOf("SELECT limited.*"))
    expect(sql).toContain("LEFT JOIN limited ON true")
  })
})

describe("EventsRepository.discoverEvents", () => {
  it("filters before the keyset limit and hydrates only matching ids", async () => {
    const { db, query } = makeDb()
    await new EventsRepository(db).discoverEvents({
      range: "weekend",
      now: "2026-08-16T15:00:00Z",
      cityId: "city",
      keyword: "storytime",
      ages: [2, 7],
      ageMode: "all",
      includeUnknownAge: true,
      limit: 25,
      after: { startDatetime: "after-start", id: "after-id" },
    })
    const [sql, params] = query.mock.calls[0]!
    expect(sql.indexOf("e.end_datetime")).toBeLessThan(sql.indexOf("LIMIT"))
    expect(sql.indexOf("age_min IS NOT NULL AND age_max IS NOT NULL")).toBeLessThan(
      sql.indexOf("LIMIT")
    )
    expect(sql).toContain("AT TIME ZONE z.zone")
    expect(sql).toContain("p_event_ids => ARRAY(SELECT id FROM candidates)")
    expect(sql).toContain("ee.source_details_fetched_at")
    expect(sql.indexOf("e.admission_cost_state")).toBeLessThan(sql.indexOf("LIMIT"))
    expect(params).toEqual([
      "weekend",
      "2026-08-16T15:00:00Z",
      "city",
      "storytime",
      null,
      [2, 7],
      "all",
      true,
      null,
      null,
      "after-start",
      "after-id",
      25,
      null,
      null,
    ])
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

  it("does not post-filter the limited legacy RPC result by multi-age criteria", async () => {
    const { db, query } = makeDb()
    await new EventsRepository(db).searchEvents()
    const [sql] = query.mock.calls[0]!
    expect(sql).toContain("NULL::text AS age_match")
    expect(sql).not.toContain("unnest(")
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
