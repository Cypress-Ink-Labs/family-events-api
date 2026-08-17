// Ported verbatim from family-events-backend
// supabase/functions/scrape-source/parsers/ical-lafayette-sources_test.ts (U28).
// Deviations: Deno.test converted to vitest describe/it, local assert helpers replaced with
// expect, and Deno.readTextFile fixture loading replaced with node:fs readFileSync.

/**
 * Tests for the three new Lafayette iCal sources using the existing icalParser.
 * All use The Events Calendar (ECPv6) WordPress plugin — iCal feeds are
 * structurally identical and handled by the existing parseIcalFeed function.
 *
 * Covers:
 *   - Lafayette Mom  (thelafayettemom.com/events/?ical=1)
 *   - Hilliard Art Museum  (hilliardartmuseum.org/events/?ical=1)
 *   - Vermilionville  (bayouvermiliondistrict.org/events/?ical=1)
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { parseIcalFeed } from "./ical.js"

const FIXTURES = join(process.cwd(), "src", "pipeline", "ingestion", "parsers", "__fixtures__")

function readFixture(relativePath: string): string {
  return readFileSync(join(FIXTURES, relativePath), "utf8")
}

// ---------------------------------------------------------------------------
// Lafayette Mom
// ---------------------------------------------------------------------------

describe("Lafayette iCal sources", () => {
  it("Lafayette Mom iCal: parses timed event with TZID", () => {
    const ical = readFixture("ical/lafayette-mom-sample.ics")
    const events = parseIcalFeed(ical)

    const timed = events.find((e) => e.title === "Stay & Play: West Regional Library")
    expect(timed, "should find timed event").toBeDefined()
    // 9:30 AM CDT (UTC-5) = 14:30 UTC
    expect(timed!.startDatetime).toBe("2026-06-01T14:30:00.000Z")
    expect(timed!.endDatetime).toBe("2026-06-01T15:30:00.000Z")
    expect(
      timed!.sourceUrl?.includes("thelafayettemom.com") ?? false,
      "sourceUrl should point to lafayettemom.com"
    ).toBe(true)
  })

  it("Lafayette Mom iCal: parses all-day DATE event (no time)", () => {
    const ical = readFixture("ical/lafayette-mom-sample.ics")
    const events = parseIcalFeed(ical)

    const allDay = events.find((e) => e.title === "Book Buddy: West Regional Library")
    expect(allDay, "should find all-day event").toBeDefined()
    // VALUE=DATE with no TZID should produce a UTC midnight start
    expect(allDay!.startDatetime.startsWith("2026-06-07"), "start date should be 2026-06-07").toBe(
      true
    )
    expect(allDay!.description.length > 0, "description should be populated").toBe(true)
  })

  it("Lafayette Mom iCal: returns expected event count", () => {
    const ical = readFixture("ical/lafayette-mom-sample.ics")
    const events = parseIcalFeed(ical)
    expect(events.length).toBe(2)
  })

  // ---------------------------------------------------------------------------
  // Hilliard Art Museum
  // ---------------------------------------------------------------------------

  it("Hilliard iCal: parses family event with LOCATION, CATEGORIES, and ATTACH image", () => {
    const ical = readFixture("ical/hilliard-sample.ics")
    const events = parseIcalFeed(ical)

    const cafe = events.find((e) => e.title?.includes("Create & Play Café"))
    expect(cafe, "should find Create & Play Café event").toBeDefined()
    expect(cafe!.venueName).toBe(
      "Hilliard Art Museum, 710 E St Mary Blvd, Lafayette, LA, 70503, United States"
    )
    expect(cafe!.address).toBe(
      "Hilliard Art Museum, 710 E St Mary Blvd, Lafayette, LA, 70503, United States"
    )
    expect(
      cafe!.imageUrl?.includes("kids-cafe.webp") ?? false,
      "should extract webp image from ATTACH"
    ).toBe(true)
    expect(cafe!.description.includes("ages 4 and up"), "description should be preserved").toBe(
      true
    )
  })

  it("Hilliard iCal: parses Learn-category event with image", () => {
    const ical = readFixture("ical/hilliard-sample.ics")
    const events = parseIcalFeed(ical)

    const tour = events.find((e) => e.title?.includes("Gulf Streams"))
    expect(tour, "should find guided tour event").toBeDefined()
    expect(tour!.imageUrl !== null, "should have image from ATTACH").toBe(true)
    expect(
      tour!.sourceUrl?.includes("hilliardartmuseum.org") ?? false,
      "sourceUrl should point to hilliardartmuseum.org"
    ).toBe(true)
  })

  it("Hilliard iCal: returns expected event count", () => {
    const ical = readFixture("ical/hilliard-sample.ics")
    const events = parseIcalFeed(ical)
    expect(events.length).toBe(2)
  })

  // ---------------------------------------------------------------------------
  // Vermilionville
  // ---------------------------------------------------------------------------

  it("Vermilionville iCal: parses recurring weekly Cajun Jam with image", () => {
    const ical = readFixture("ical/vermilionville-sample.ics")
    const events = parseIcalFeed(ical)

    const jam = events.find((e) => e.title?.includes("CFMA Cajun Jam"))
    expect(jam, "should find Cajun Jam event").toBeDefined()
    // 1 PM CDT = 18:00 UTC
    expect(jam!.startDatetime).toBe("2026-05-30T18:00:00.000Z")
    expect(jam!.endDatetime).toBe("2026-05-30T20:00:00.000Z")
    expect(jam!.venueName).toBe(
      "Vermilionville, 300 Fisher Road, Lafayette, LA, 70508, United States"
    )
    expect(
      jam!.imageUrl?.includes("cajunjam3.jpg") ?? false,
      "should extract jpeg image from ATTACH"
    ).toBe(true)
    expect(jam!.isFree === true, "Cajun Jam is free — should detect from description").toBe(true)
  })

  it("Vermilionville iCal: parses Homeschool Days event", () => {
    const ical = readFixture("ical/vermilionville-sample.ics")
    const events = parseIcalFeed(ical)

    const homeschool = events.find((e) => e.title?.includes("Homeschool Days"))
    expect(homeschool, "should find Homeschool Days event").toBeDefined()
    expect(homeschool!.description.length > 0, "description should be populated").toBe(true)
    expect(
      homeschool!.sourceUrl?.includes("bayouvermiliondistrict.org") ?? false,
      "sourceUrl should point to bayouvermiliondistrict.org"
    ).toBe(true)
    // $6 / $10 admission — not free
    expect(homeschool!.isFree).toBe(false)
  })

  it("Vermilionville iCal: returns expected event count", () => {
    const ical = readFixture("ical/vermilionville-sample.ics")
    const events = parseIcalFeed(ical)
    expect(events.length).toBe(2)
  })
})
