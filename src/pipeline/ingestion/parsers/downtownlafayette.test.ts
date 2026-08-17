// Ported verbatim from family-events-backend
// supabase/functions/scrape-source/parsers/downtownlafayette_test.ts (U28).
// Deviations: Deno.test converted to vitest describe/it; local assertEquals /
// assert helpers replaced with expect; Deno.readTextFile fixture loading
// replaced with node:fs readFileSync; non-null assertions on find() results
// replaced with optional chaining for noUncheckedIndexedAccess.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { parseDowntownLafayetteEvents } from "./downtownlafayette.js"

const FIXTURES = join(process.cwd(), "src", "pipeline", "ingestion", "parsers", "__fixtures__")

function readFixture(relativePath: string): string {
  return readFileSync(join(FIXTURES, relativePath), "utf8")
}

describe("DDA parser", () => {
  // Use a fixed "now" so year-inference is deterministic: 2026-05-01
  const NOW = new Date("2026-05-01T12:00:00Z")

  it("parses timed event with venue and image", () => {
    const html = readFixture("downtownlafayette/events-page.html")
    const events = parseDowntownLafayetteEvents(html, NOW)

    const book = events.find((e) => e.title?.includes("Shannon Terry Wiley"))
    expect(book, "should find Shannon Terry Wiley event").toBeDefined()
    // Jun 15 6:00 pm CDT = Jun 15 23:00 UTC
    expect(book?.startDatetime).toBe("2026-06-15T23:00:00.000Z")
    expect(book?.endDatetime).toBe("2026-06-16T01:00:00.000Z")
    expect(book?.venueName).toBe("Cavalier House Books - Lafayette")
    expect(book?.sourceUrl?.includes("/event/an-evening-with-shannon-terry-wiley") ?? false).toBe(
      true
    )
    expect(
      book?.imageUrl?.includes("event1.jpeg") ?? false,
      "should extract image from g_visual_img"
    ).toBe(true)
  })

  it("parses Bach Lunch with correct noon time", () => {
    const html = readFixture("downtownlafayette/events-page.html")
    const events = parseDowntownLafayetteEvents(html, NOW)

    const bach = events.find((e) => e.title?.includes("Bach Lunch"))
    expect(bach, "should find Bach Lunch event").toBeDefined()
    // Jun 20 11:00 am CDT = 16:00 UTC
    expect(bach?.startDatetime).toBe("2026-06-20T16:00:00.000Z")
    expect(bach?.endDatetime).toBe("2026-06-20T18:00:00.000Z")
    expect(bach?.venueName).toBe("Parc Sans Souci")
  })

  it("sourceUrl is absolute for /event/ href", () => {
    const html = readFixture("downtownlafayette/events-page.html")
    const events = parseDowntownLafayetteEvents(html, NOW)

    for (const e of events) {
      if (e.sourceUrl) {
        expect(
          e.sourceUrl.startsWith("https://"),
          `sourceUrl should be absolute: ${e.sourceUrl}`
        ).toBe(true)
      }
    }
  })

  it("all-day event (no time) defaults to midnight", () => {
    const html = readFixture("downtownlafayette/events-page.html")
    const events = parseDowntownLafayetteEvents(html, NOW)

    const fest = events.find((e) => e.title === "All-Day Festival")
    expect(fest, "should find All-Day Festival").toBeDefined()
    // No time in card — defaults to 00:00 CDT = 05:00 UTC
    expect(fest?.startDatetime).toBe("2026-07-04T05:00:00.000Z")
    expect(fest?.endDatetime).toBe(null)
  })

  it("deduplicates repeated event keys", () => {
    const html = readFixture("downtownlafayette/events-page.html")
    const events = parseDowntownLafayetteEvents(html, NOW)
    const titles = events.map((e) => e.title)
    const unique = new Set(
      titles.map(
        (t) => t?.toLowerCase() + "::" + (events.find((e) => e.title === t)?.startDatetime ?? "")
      )
    )
    expect(unique.size, "no duplicate title+time pairs").toBe(events.length)
  })

  it("returns expected event count", () => {
    const html = readFixture("downtownlafayette/events-page.html")
    const events = parseDowntownLafayetteEvents(html, NOW)
    expect(events.length).toBe(4)
  })

  it("empty HTML returns empty array", () => {
    const events = parseDowntownLafayetteEvents("<html><body></body></html>", NOW)
    expect(events.length).toBe(0)
  })
})
