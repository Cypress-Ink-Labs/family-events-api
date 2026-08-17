// Ported verbatim from family-events-backend supabase/functions/scrape-source/parsers/rss_test.ts (U28).
// Deviations: Deno.test converted to vitest describe/it, local assert helpers replaced with
// expect, Deno.readTextFile fixture loading replaced with node:fs readFileSync, and indexed event
// access uses optional chaining for noUncheckedIndexedAccess.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { parseRssFeed } from "./rss.js"

const FIXTURES = join(process.cwd(), "src", "pipeline", "ingestion", "parsers", "__fixtures__")

function readFixture(relativePath: string): string {
  return readFileSync(join(FIXTURES, relativePath), "utf8")
}

describe("rss parser", () => {
  it("parseRssFeed parses RSS item with CDATA, images, and price", () => {
    const xml = readFixture("rss/cdata-media.xml")
    const events = parseRssFeed(xml, "https://feed.example.com/rss.xml")

    expect(events.length).toBe(1)
    expect(events[0]?.title).toBe("Family Fun Night")
    expect(events[0]?.description).toContain("Bring kids for games")
    expect(events[0]?.startDatetime).toBe("2026-04-15T14:30:00.000Z")
    expect(events[0]?.sourceUrl).toBe("https://feed.example.com/events/family-fun")
    expect(events[0]?.price).toBe(12.5)
    expect(events[0]?.images.includes("https://cdn.example.com/family-fun.jpg")).toBe(true)
    expect(events[0]?.images.includes("https://cdn.example.com/flyer.png")).toBe(true)
    expect(events[0]?.images.includes("https://feed.example.com/images/fun.jpg")).toBe(true)
  })

  it("parseRssFeed reads namespaced dc:date in RSS", () => {
    const xml = readFixture("rss/dc-date.xml")
    const events = parseRssFeed(xml, "https://feed.example.com/dc.xml")

    expect(events.length).toBe(1)
    expect(events[0]?.title).toBe("Community Picnic")
    expect(events[0]?.startDatetime).toBe("2026-05-02T15:00:00.000Z")
    expect(events[0]?.isFree).toBe(true)
  })

  it("parseRssFeed parses Atom entry content and link href", () => {
    const xml = readFixture("atom/entry-content.xml")
    const events = parseRssFeed(xml, "https://atom.example.com/feed.xml")

    expect(events.length).toBe(1)
    expect(events[0]?.title).toBe("Neighborhood Meetup")
    expect(events[0]?.startDatetime).toBe("2026-06-01T23:00:00.000Z")
    expect(events[0]?.description).toContain("Join us downtown")
    expect(events[0]?.sourceUrl).toBe("https://atom.example.com/events/meetup")
    expect(events[0]?.images.includes("https://atom.example.com/image.jpg")).toBe(true)
  })
})
