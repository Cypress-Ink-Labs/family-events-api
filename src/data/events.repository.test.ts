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
    // Default status published, default keyset page of 24, everything else null.
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

describe("ReferenceRepository.listCities", () => {
  it("lists only active cities in name order", async () => {
    const { db, query } = makeDb()
    await new ReferenceRepository(db).listCities()
    const sql = query.mock.calls[0]?.[0] ?? ""
    expect(sql).toContain("is_active = true")
    expect(sql).toContain("ORDER BY name ASC")
  })
})
