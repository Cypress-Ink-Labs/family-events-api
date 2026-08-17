// Ported verbatim from family-events-backend
// supabase/functions/scrape-source/parsers/lcg-lafayette_test.ts (U28).
// Deviations: Deno.test converted to vitest describe/it; local assertEquals /
// assert helpers replaced with expect; Deno.readTextFile fixture loading
// replaced with node:fs readFileSync; non-null assertions on find() results
// replaced with optional chaining for noUncheckedIndexedAccess.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { parseLcgEventUrl, parseLcgEvents } from "./lcg-lafayette.js"

const FIXTURES = join(process.cwd(), "src", "pipeline", "ingestion", "parsers", "__fixtures__")

function readFixture(relativePath: string): string {
  return readFileSync(join(FIXTURES, relativePath), "utf8")
}

// ---------------------------------------------------------------------------
// parseLcgEventUrl
// ---------------------------------------------------------------------------

describe("parseLcgEventUrl", () => {
  it("extracts datetime from standard slug", () => {
    const { startDatetime } = parseLcgEventUrl(
      "https://events.lafayettela.gov/default/detail/2026-05-27-1730-2026-Disaster-Ready-Workshop"
    )
    // 17:30 CDT (UTC-5) = 22:30 UTC
    expect(startDatetime).toBe("2026-05-27T22:30:00.000Z")
  })

  it("extracts morning event (09:00 CDT = 14:00 UTC)", () => {
    const { startDatetime } = parseLcgEventUrl(
      "https://events.lafayettela.gov/default/detail/2026-06-02-0900-Summer-Splash-Kids-Camp"
    )
    expect(startDatetime).toBe("2026-06-02T14:00:00.000Z")
  })

  it("returns null for unrecognised slug", () => {
    const { startDatetime } = parseLcgEventUrl(
      "https://events.lafayettela.gov/default/detail/some-event"
    )
    expect(startDatetime).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// parseLcgEvents
// ---------------------------------------------------------------------------

describe("LCG parser", () => {
  it("parses all events from fixture", () => {
    const html = readFixture("lcglafayette/events-page.html")
    const events = parseLcgEvents(html)
    expect(events.length).toBe(3)
  })

  it("extracts title and datetime for first event", () => {
    const html = readFixture("lcglafayette/events-page.html")
    const events = parseLcgEvents(html)

    const workshop = events.find((e) => e.title?.includes("Disaster Ready"))
    expect(workshop, "should find Disaster Ready Workshop").toBeDefined()
    expect(workshop?.startDatetime).toBe("2026-05-27T22:30:00.000Z")
    expect(
      workshop?.sourceUrl?.includes("events.lafayettela.gov") ?? false,
      "sourceUrl should be the events.lafayettela.gov URL"
    ).toBe(true)
  })

  it("extracts family-relevant Summer Camp event", () => {
    const html = readFixture("lcglafayette/events-page.html")
    const events = parseLcgEvents(html)

    const camp = events.find((e) => e.title?.includes("Summer Splash"))
    expect(camp, "should find Summer Splash Kids Camp").toBeDefined()
    expect(camp?.startDatetime).toBe("2026-06-02T14:00:00.000Z")
    expect(camp?.venueName, "no venue on listing page — expected null").toBe(null)
  })

  it("empty HTML returns empty array", () => {
    const events = parseLcgEvents("<html><body></body></html>")
    expect(events.length).toBe(0)
  })

  it("deduplicates identical title+datetime pairs", () => {
    const html = `<html><body><ul class="gs-feed-list-events">
      <li class="gs-feed-list-item">
        <div class="gs-feed-list-meta">
          <a href="https://events.lafayettela.gov/default/detail/2026-07-01-1000-Test-Event" class="gs-feed-list-title">Test Event</a>
        </div>
      </li>
      <li class="gs-feed-list-item">
        <div class="gs-feed-list-meta">
          <a href="https://events.lafayettela.gov/default/detail/2026-07-01-1000-Test-Event" class="gs-feed-list-title">Test Event</a>
        </div>
      </li>
    </ul></body></html>`
    const events = parseLcgEvents(html)
    expect(events.length).toBe(1)
  })
})
