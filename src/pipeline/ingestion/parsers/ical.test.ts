// Ported verbatim from family-events-backend supabase/functions/scrape-source/parsers/ical_test.ts (U28).
// Deviations: Deno.test converted to vitest describe/it, local assert helpers replaced with
// expect, Deno.readTextFile fixture loading replaced with node:fs readFileSync, and indexed event
// access uses optional chaining for noUncheckedIndexedAccess.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { parseIcalFeed } from "./ical.js"

const FIXTURES = join(process.cwd(), "src", "pipeline", "ingestion", "parsers", "__fixtures__")

function readFixture(relativePath: string): string {
  return readFileSync(join(FIXTURES, relativePath), "utf8")
}

describe("ical parser", () => {
  it("parseIcalFeed unfolds lines, respects TZID, and unescapes text", () => {
    const ical = readFixture("ical/folded-tzid.ics")
    const events = parseIcalFeed(ical)

    expect(events.length).toBe(1)
    expect(events[0]?.title).toBe("Neighborhood Orchestra")
    expect(events[0]?.startDatetime).toBe("2026-05-15T23:30:00.000Z")
    expect(events[0]?.endDatetime).toBe("2026-05-16T01:00:00.000Z")
    expect(events[0]?.description).toContain("continuation text; bring chairs")
    expect(events[0]?.description).toContain("Snacks included")
    expect(events[0]?.venueName).toBe("Town Hall, Main Street")
    expect(events[0]?.images.includes("https://calendar.example.com/poster.jpg")).toBe(true)
  })

  it("parseIcalFeed keeps RRULE events as single parsed instance", () => {
    const ical = readFixture("ical/rrule.ics")
    const events = parseIcalFeed(ical)

    expect(events.length).toBe(1)
    expect(events[0]?.title).toBe("Weekly Market")
    expect(events[0]?.startDatetime).toBe("2026-06-01T09:00:00.000Z")
    expect(events[0]?.endDatetime).toBe("2026-06-01T11:00:00.000Z")
    expect(events[0]?.sourceUrl).toBe("https://calendar.example.com/events/market")
  })

  it("parseIcalFeed throws on truncated feed missing END:VCALENDAR", () => {
    // Real-world failure mode: upstream returned a 23-byte fragment of a
    // VCALENDAR. The parser used to silently emit zero events; the worker
    // then surfaced a generic "no valid events" error that masked the
    // transport-layer truncation.
    const truncated = "BEGIN:VCALENDAR\nVERSI"
    expect(() => parseIcalFeed(truncated)).toThrow("Truncated iCal feed")
  })

  it("parseIcalFeed returns [] for empty body without VCALENDAR header", () => {
    expect(parseIcalFeed("").length).toBe(0)
    expect(parseIcalFeed("\n\n").length).toBe(0)
  })

  it("parseIcalFeed sets venueName and address to null when LOCATION is a URL", () => {
    const ical = readFixture("ical/online-location-url.ics")
    const events = parseIcalFeed(ical)

    expect(events.length).toBe(1)
    expect(events[0]?.title).toBe("Virtual Team Meeting")
    expect(events[0]?.venueName).toBe(null)
    expect(events[0]?.address).toBe(null)
  })

  it("parseIcalFeed preserves physical LOCATION as venueName and address", () => {
    const ical = readFixture("ical/physical-location.ics")
    const events = parseIcalFeed(ical)

    expect(events.length).toBe(1)
    expect(events[0]?.title).toBe("Gala Dinner")
    expect(events[0]?.venueName).toBe("The Grand Ballroom")
    expect(events[0]?.address).toBe("The Grand Ballroom")
  })
})
