import { describe, expect, it } from "vitest"

import { escapeIlike, projectEvent, type EventRow } from "./public-event.js"

const ROW: EventRow = {
  id: "0b6a3f5e-1111-4222-8333-444455556666",
  title: "Storytime",
  description: "At the library",
  start_datetime: "2026-08-16T15:00:00+00:00",
  end_datetime: null,
  timezone: "America/Chicago",
  venue_name: "Main Library",
  address: "101 Main",
  city_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  latitude: 30.22,
  longitude: -92.02,
  age_min: 2,
  age_max: 6,
  price: "0",
  is_free: true,
  is_featured: false,
  is_outdoor: false,
  images: ["https://example.com/a.jpg"],
  source_url: "https://example.com/event",
}

describe("projectEvent", () => {
  it("maps snake_case rows and attaches tags", () => {
    const tags = [{ id: "t1", name: "Free", slug: "free", color: "#111" }]
    const event = projectEvent(ROW, tags)
    expect(event.startDatetime).toBe(ROW.start_datetime)
    expect(event.price).toBe(0)
    expect(event.images).toEqual(["https://example.com/a.jpg"])
    expect(event.tags).toEqual(tags)
  })

  it("treats a non-array images jsonb value as empty", () => {
    expect(projectEvent({ ...ROW, images: { url: "x" } }, []).images).toEqual([])
  })
})

describe("escapeIlike", () => {
  it("escapes LIKE metacharacters the same way search_events does", () => {
    expect(escapeIlike(`100%_fun\\day`)).toBe(`100\\%\\_fun\\\\day`)
  })
})
