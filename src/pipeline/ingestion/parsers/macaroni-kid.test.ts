// Ported verbatim from family-events-backend supabase/functions/scrape-source/parsers/macaroni-kid_test.ts (U28).
// Deviations: Deno.test converted to vitest describe/it; assertEquals/assertRejects converted to
// expect equivalents; fixtures read synchronously via node:fs instead of Deno.readTextFile;
// noUncheckedIndexedAccess handled with `?? ""` / optional chaining on indexed access.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { fetchMacaroniKidEvents, mapMacaroniKidEvent } from "./macaroni-kid.js"
import type { EventSourceRow } from "../types.js"

const FIXTURES = join(process.cwd(), "src", "pipeline", "ingestion", "parsers", "__fixtures__")

function readFixture(relativePath: string): string {
  return readFileSync(join(FIXTURES, relativePath), "utf8")
}

function buildSource(overrides: Partial<EventSourceRow> = {}): EventSourceRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    name: "Macaroni Kid Lafayette",
    url: "https://lafayettela.macaronikid.com/events",
    source_type: "macaronikid",
    extraction_mode: "deterministic",
    city_id: "00000000-0000-0000-0000-0000000000aa",
    is_active: true,
    auto_approve: false,
    scrape_interval_hours: 12,
    last_scraped_at: null,
    last_status: null,
    error_count: 0,
    date_window_days: 30,
    consecutive_zero_result_scrapes: 0,
    stale_escalated_at: null,
    ...overrides,
  }
}

describe("macaroni-kid parser", () => {
  it("mapMacaroniKidEvent constructs ParsedEvent from JSON node", () => {
    const raw = {
      _id: "abc123",
      slug: "park-day",
      name: "Park Day",
      start: "2026-06-01T14:00:00.000Z",
      end: "2026-06-01T16:00:00.000Z",
      location: {
        name: "Moncus Park",
        address: "2913 Johnston St",
        city: "Lafayette",
        state: "LA",
      },
      cost: "Free",
      who: "Toddlers",
      where: "Playground",
      how: "Drop in",
      image: "https://images.macaronikid.com/park.jpg",
    }
    const parsed = mapMacaroniKidEvent(raw, "https://lafayettela.macaronikid.com/events")
    if (!parsed) throw new Error("expected parsed event")
    expect(parsed.title).toBe("Park Day")
    expect(parsed.startDatetime).toBe("2026-06-01T14:00:00.000Z")
    expect(parsed.endDatetime).toBe("2026-06-01T16:00:00.000Z")
    expect(parsed.venueName).toBe("Moncus Park")
    expect(parsed.address).toBe("2913 Johnston St, Lafayette, LA")
    expect(parsed.sourceUrl).toBe("https://lafayettela.macaronikid.com/events/abc123/park-day")
    expect(parsed.isFree).toBe(true)
    expect(parsed.imageUrl).toBe("https://images.macaronikid.com/park.jpg")
  })

  it("mapMacaroniKidEvent rejects nodes without title or start", () => {
    expect(mapMacaroniKidEvent({ start: "2026-06-01T14:00:00Z" }, "https://x.example/events")).toBe(
      null
    )
    expect(mapMacaroniKidEvent({ name: "No date" }, "https://x.example/events")).toBe(null)
    expect(mapMacaroniKidEvent(null, "https://x.example/events")).toBe(null)
  })

  it("mapMacaroniKidEvent accepts startDateTime/endDateTime (real API shape)", () => {
    // Macaroni Kid API returns startDateTime/endDateTime, not start/end or startDate/endDate.
    // Earlier regression: all events dropped because parser only checked start/startDate.
    const raw = {
      _id: "real1",
      title: "Real API Event",
      startDateTime: "2026-07-01T15:00:00.000Z",
      endDateTime: "2026-07-01T17:00:00.000Z",
      location: { name: "Some Venue" },
    }
    const parsed = mapMacaroniKidEvent(raw, "https://lafayettela.macaronikid.com/events")
    if (!parsed) throw new Error("expected parsed event")
    expect(parsed.title).toBe("Real API Event")
    expect(parsed.startDatetime).toBe("2026-07-01T15:00:00.000Z")
    expect(parsed.endDatetime).toBe("2026-07-01T17:00:00.000Z")
  })

  it("fetchMacaroniKidEvents two-hop fetch + town extraction + mapping", async () => {
    const html = readFixture("macaronikid/lafayette-page.html")
    const apiJson = readFixture("macaronikid/lafayette-api.json")
    const source = buildSource()
    const calls: string[] = []

    const fetchText = (url: string) => {
      calls.push(`text:${url}`)
      return Promise.resolve(html)
    }
    const fetchJson = <T>(url: string): Promise<T> => {
      calls.push(`json:${url}`)
      return Promise.resolve(JSON.parse(apiJson) as T)
    }

    const events = await fetchMacaroniKidEvents(
      source,
      fetchText,
      fetchJson,
      new Date("2026-05-16T00:00:00.000Z")
    )

    expect(events.length).toBe(2)
    expect(calls[0]).toBe("text:https://lafayettela.macaronikid.com/events")
    const apiCall = calls[1] ?? ""
    if (!apiCall.startsWith("json:https://api.macaronikid.com/api/v1/event/v2?query=")) {
      throw new Error(`unexpected api url: ${apiCall}`)
    }
    if (!apiCall.includes("58252a7a6f1aaf645c94f083")) {
      throw new Error(`townId missing from api url: ${apiCall}`)
    }
    if (!apiCall.includes("limit=802")) {
      throw new Error(`limit missing from api url: ${apiCall}`)
    }

    const story = events[0]
    expect(story?.title).toBe("Family Storytime at the Library")
    expect(story?.venueName).toBe("Lafayette Main Library")
    expect(story?.address).toBe("301 W Congress St, Lafayette, LA, 70501")
    expect(story?.sourceUrl).toBe(
      "https://lafayettela.macaronikid.com/events/65d000000000000000000001/family-storytime-at-the-library"
    )
    expect(story?.isFree).toBe(true)
    expect(story?.imageUrl).toBe("https://images.macaronikid.com/storytime.jpg")

    const music = events[1]
    expect(music?.title).toBe("Summer Music Night")
    expect(music?.isFree).toBe(false)
    expect(music?.price).toBe(10)
    expect(music?.images.length).toBe(2)
  })

  it("fetchMacaroniKidEvents throws when data-town attribute is missing", async () => {
    const source = buildSource()
    await expect(
      fetchMacaroniKidEvents(
        source,
        () => Promise.resolve("<html><body>no town here</body></html>"),
        <T>(): Promise<T> => Promise.reject(new Error("should not call API"))
      )
    ).rejects.toThrow("data-town")
  })

  it("fetchMacaroniKidEvents accepts wrapped response shapes ({events: [...]})", async () => {
    const html = readFixture("macaronikid/lafayette-page.html")
    const source = buildSource()
    const events = await fetchMacaroniKidEvents(
      source,
      () => Promise.resolve(html),
      <T>() =>
        Promise.resolve({
          events: [
            {
              _id: "x1",
              slug: "wrapped",
              name: "Wrapped Event",
              start: "2026-06-01T14:00:00Z",
            },
          ],
        } as T)
    )
    expect(events.length).toBe(1)
    expect(events[0]?.title).toBe("Wrapped Event")
  })

  it("fetchMacaroniKidEvents respects date_window_days override in API URL", async () => {
    const html = readFixture("macaronikid/lafayette-page.html")
    const source = buildSource({ date_window_days: 7 })
    let capturedUrl = ""
    await fetchMacaroniKidEvents(
      source,
      () => Promise.resolve(html),
      <T>(url: string) => {
        capturedUrl = url
        return Promise.resolve([] as unknown as T)
      },
      new Date("2026-05-16T00:00:00.000Z")
    )
    if (!capturedUrl.includes(encodeURIComponent("2026-05-23T00:00:00.000Z"))) {
      throw new Error(`expected 7-day window end in url, got ${capturedUrl}`)
    }
  })

  it("mapMacaroniKidEvent reads top-level address object (real API v1 shape)", () => {
    // Real Macaroni Kid API v1 returns address data as a top-level 'address' object
    // (street1, city, state, zipCode) and venue name in the 'where' field.
    // The 'location' object only carries GeoJSON coordinates and should not be
    // used for geocoding eligibility.
    const raw = {
      _id: "69efca2a1944d7714560fffc",
      title: "Splash Pad!",
      startDateTime: "2026-05-26T15:00:00.000Z",
      where: "Broussard Sports Complex - St. Julien Park",
      address: {
        street1: "701 St. Nazaire",
        street2: "",
        city: "Broussard",
        state: "LA",
        zipCode: "70518",
      },
      location: { coordinates: [0, 0], type: "Point" },
      cost: "FREE",
    }
    const parsed = mapMacaroniKidEvent(raw, "https://lafayettela.macaronikid.com/events")
    if (!parsed) throw new Error("expected parsed event")
    expect(parsed.venueName).toBe("Broussard Sports Complex - St. Julien Park")
    expect(parsed.address).toBe("701 St. Nazaire, Broussard, LA, 70518")
    expect(parsed.isFree).toBe(true)
  })
})
