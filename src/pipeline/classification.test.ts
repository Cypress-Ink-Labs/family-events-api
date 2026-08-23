import { describe, expect, it } from "vitest"

import {
  clampConfidence,
  computeTags,
  extractAgeRangeFromText,
  extractPriceFromText,
  extractVenueFromText,
} from "./classification.js"

// Ported from family-events-backend supabase/functions/_shared/classification.test.ts (U29)

describe("clampConfidence", () => {
  it("returns 0.5 for NaN input", () => {
    expect(clampConfidence(Number.NaN)).toBe(0.5)
  })

  it("clamps to [0, 1]", () => {
    expect(clampConfidence(-1)).toBe(0)
    expect(clampConfidence(2)).toBe(1)
    expect(clampConfidence(0.7)).toBe(0.7)
  })
})

describe("computeTags", () => {
  it("assigns music tag for concert keywords", () => {
    const tags = computeTags("Family Concert Series", "Live music at the park")
    expect(tags.some((t) => t.slug === "music")).toBe(true)
  })

  it("handles multiple tags on one event and sorts by confidence", () => {
    const tags = computeTags("Outdoor Music Storytime", "Picnic and book reading in the park")
    const slugs = tags.map((t) => t.slug)
    expect(slugs).toContain("music")
    expect(slugs).toContain("outdoor")
    expect(slugs).toContain("storytime")
    // Descending confidence
    for (let i = 1; i < tags.length; i++) {
      expect(tags[i - 1]!.confidence).toBeGreaterThanOrEqual(tags[i]!.confidence)
    }
  })

  it("returns empty array when no keywords match", () => {
    expect(computeTags("Tax prep seminar", "Adult financial planning")).toEqual([])
  })

  it("caps individual tag confidence at 0.98", () => {
    // Many music keyword hits shouldn't push past the cap
    const tags = computeTags(
      "music concert band drum guitar violin choir",
      "karaoke sing song musical instrument"
    )
    const music = tags.find((t) => t.slug === "music")
    expect(music).toBeDefined()
    expect(music!.confidence).toBeLessThanOrEqual(0.98)
  })

  it("uses combined title + description for matching", () => {
    // Keyword only appears in description, must still match
    expect(computeTags("Weekend event", "bring your favorite toddler")).toEqual(
      expect.arrayContaining([expect.objectContaining({ slug: "playgroup" })])
    )
  })

  // U29 CodeRabbit regression: keywords must not match as embedded substrings.
  it("does not tag words that merely contain a keyword as a substring", () => {
    expect(computeTags("Birthday Party", "Parking available onsite")).toEqual([])
  })

  it("still tags real keyword words after switching to token matching", () => {
    const tags = computeTags("Party in the Park", "Arts and crafts tables")
    expect(tags.some((t) => t.slug === "outdoor")).toBe(true)
    expect(tags.some((t) => t.slug === "art")).toBe(true)
  })
})

describe("extractAgeRangeFromText", () => {
  it("parses hyphenated year ranges", () => {
    expect(extractAgeRangeFromText("", "ages 3-8 years")).toEqual({ ageMin: 3, ageMax: 8 })
  })

  it("parses 'to' ranges", () => {
    expect(extractAgeRangeFromText("", "ages 2 to 6 yrs")).toEqual({ ageMin: 2, ageMax: 6 })
  })

  it("parses plus ranges (e.g. ages 5+)", () => {
    expect(extractAgeRangeFromText("", "ages 5+")).toEqual({ ageMin: 5, ageMax: null })
  })

  it("parses 'under N' ranges", () => {
    expect(extractAgeRangeFromText("", "for kids under 10")).toEqual({ ageMin: null, ageMax: 10 })
  })

  it("infers toddler range", () => {
    expect(extractAgeRangeFromText("", "great for toddlers")).toEqual({ ageMin: 1, ageMax: 4 })
  })

  it("infers baby/infant range", () => {
    expect(extractAgeRangeFromText("", "baby music class")).toEqual({ ageMin: 0, ageMax: 2 })
    expect(extractAgeRangeFromText("", "infant sensory play")).toEqual({ ageMin: 0, ageMax: 2 })
  })

  it("returns null/null when nothing matches", () => {
    expect(extractAgeRangeFromText("Adult paint night", "")).toEqual({
      ageMin: null,
      ageMax: null,
    })
  })

  it("prefers explicit range over toddler/baby keywords", () => {
    // Explicit range takes precedence — the year range pattern runs first
    expect(extractAgeRangeFromText("", "toddler-friendly, ages 3-7 years")).toEqual({
      ageMin: 3,
      ageMax: 7,
    })
  })
})

describe("extractPriceFromText", () => {
  it("detects free via 'free' keyword", () => {
    expect(extractPriceFromText("Free Concert", "")).toEqual({ price: null, isFree: true })
  })

  it("detects free via 'complimentary'", () => {
    expect(extractPriceFromText("", "complimentary admission")).toEqual({
      price: null,
      isFree: true,
    })
  })

  it("extracts dollar price", () => {
    expect(extractPriceFromText("", "tickets $15")).toEqual({ price: 15, isFree: false })
  })

  it("extracts decimal price", () => {
    expect(extractPriceFromText("", "admission $12.50")).toEqual({ price: 12.5, isFree: false })
  })

  it("returns null/false when no price info present", () => {
    expect(extractPriceFromText("Music Class", "bring your instruments")).toEqual({
      price: null,
      isFree: false,
    })
  })

  it("free takes precedence over a dollar sign", () => {
    // If text says both "free" and mentions a donation amount, free wins
    expect(extractPriceFromText("", "free event, $5 suggested donation")).toEqual({
      price: null,
      isFree: true,
    })
  })

  // U29 CodeRabbit regression: \b matches after "-", so "-free" compounds must
  // not report a paid event as free.
  it("does not treat hyphenated '-free' compounds as free admission", () => {
    expect(extractPriceFromText("", "gluten-free cooking class; admission $15")).toEqual({
      price: 15,
      isFree: false,
    })
    expect(extractPriceFromText("", "sugar-free treats, $3 entry")).toEqual({
      price: 3,
      isFree: false,
    })
  })

  it("still detects standalone 'free' when a '-free' compound is present", () => {
    expect(extractPriceFromText("", "Sugar-free snacks; admission is free")).toEqual({
      price: null,
      isFree: true,
    })
  })
})

describe("extractVenueFromText", () => {
  it("extracts 'at <Venue>'", () => {
    expect(extractVenueFromText("", "Join us at Central Library for storytime.")).toEqual({
      venueName: "Central Library",
    })
  })

  it("extracts 'at the <Venue>'", () => {
    expect(extractVenueFromText("", "Meet at the City Park tomorrow")).toEqual({
      venueName: "City Park",
    })
  })

  it("extracts 'Location: <Venue>'", () => {
    expect(extractVenueFromText("", "Location: Main Street Library")).toEqual({
      venueName: "Main Street Library",
    })
  })

  it("extracts 'Where: <Venue>'", () => {
    expect(extractVenueFromText("", "Where: Sunset Community Center")).toEqual({
      venueName: "Sunset Community Center",
    })
  })

  it("returns null when no venue pattern present", () => {
    expect(extractVenueFromText("Music Concert", "bring the whole family")).toEqual({
      venueName: null,
    })
  })

  it("does not match time-based 'at' phrases as venue names", () => {
    expect(extractVenueFromText("", "We arrive at 5pm")).toEqual({ venueName: null })
    expect(extractVenueFromText("", "Registration at 9:30am")).toEqual({ venueName: null })
  })

  // U29 CodeRabbit regression: title-cased time words must not be captured.
  it("does not capture title-cased time expressions after 'at'", () => {
    expect(extractVenueFromText("", "Doors open at Noon.")).toEqual({ venueName: null })
    expect(extractVenueFromText("", "Storytime begins at Midnight")).toEqual({ venueName: null })
  })

  it("skips time expressions but still finds a later 'at' venue", () => {
    expect(extractVenueFromText("", "Doors open at Noon at Central Library")).toEqual({
      venueName: "Central Library",
    })
  })
})
