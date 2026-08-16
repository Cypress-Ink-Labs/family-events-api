import { describe, expect, it } from "vitest"

import {
  JACCARD_THRESHOLD,
  canonicalizeTitle,
  eventFingerprint,
  isCrossSourceDuplicate,
  jaccardFromTokens,
  jaccardSimilarity,
  titleTokens,
} from "./dedup.js"

// Ported from family-events-backend supabase/functions/_shared/dedup-utils_test.ts

describe("canonicalizeTitle", () => {
  it("lowercases input", () => {
    expect(canonicalizeTitle("Family STORY Time")).toBe("family story time")
  })

  it("strips punctuation (periods, commas, exclamation)", () => {
    expect(canonicalizeTitle("Fun! Events, Today.")).toBe("fun events today")
  })

  it("replaces em-dash and en-dash with space", () => {
    expect(canonicalizeTitle("Family—Fun")).toBe("family fun")
    expect(canonicalizeTitle("Kids–Story")).toBe("kids story")
  })

  it("replaces ampersand with space", () => {
    expect(canonicalizeTitle("Arts & Crafts")).toBe("arts crafts")
    expect(canonicalizeTitle("Arts & Crafts Night")).toBe("arts crafts night")
  })

  it("collapses multiple whitespace", () => {
    expect(canonicalizeTitle("  too   many   spaces  ")).toBe("too many spaces")
  })

  it("handles mixed punctuation and dashes", () => {
    expect(canonicalizeTitle("Story-Time: Family Edition!")).toBe("story time family edition")
  })

  it("empty string returns empty string", () => {
    expect(canonicalizeTitle("")).toBe("")
  })
})

describe("titleTokens", () => {
  it("returns a Set of words", () => {
    const tokens = titleTokens("Family Story Time")
    expect(tokens.has("family")).toBe(true)
    expect(tokens.has("story")).toBe(true)
    expect(tokens.has("time")).toBe(true)
    expect(tokens.size).toBe(3)
  })

  it("empty string returns empty Set", () => {
    expect(titleTokens("").size).toBe(0)
  })
})

describe("jaccardSimilarity", () => {
  it("identical titles return 1.0", () => {
    expect(jaccardSimilarity("Family Story Time", "Family Story Time")).toBe(1.0)
  })

  it("identical after canonicalization return 1.0", () => {
    expect(jaccardSimilarity("Family Story Time!", "family story time")).toBe(1.0)
  })

  it("completely disjoint titles return 0.0", () => {
    expect(jaccardSimilarity("Art Workshop", "Science Fair")).toBe(0.0)
  })

  it("partial overlap — 2 shared out of 4 unique tokens = 0.5", () => {
    // A = {alpha, beta, charlie}, B = {alpha, beta, delta} → intersection=2, union=4
    expect(jaccardSimilarity("alpha beta charlie", "alpha beta delta")).toBe(0.5)
  })

  it("1 shared out of 3 unique tokens = 1/3", () => {
    expect(jaccardSimilarity("family story", "family time")).toBeCloseTo(1 / 3, 10)
  })

  it("both empty strings return 0", () => {
    expect(jaccardSimilarity("", "")).toBe(0)
  })

  it("'Family Storytime' vs 'Storytime Family Edition' is below 0.7 threshold", () => {
    // intersection = {family, storytime} = 2; union = 3 → 2/3 ≈ 0.667
    const result = jaccardSimilarity("Family Storytime", "Storytime Family Edition")
    expect(result).toBeCloseTo(2 / 3, 10)
    expect(result).toBeLessThan(JACCARD_THRESHOLD)
  })

  it("same tokens regardless of order = 1.0", () => {
    expect(jaccardSimilarity("Family Story Time", "Story Time Family")).toBe(1.0)
  })

  it("jaccardFromTokens reuses prepared sets without changing similarity", () => {
    expect(
      jaccardFromTokens(titleTokens("Family Story Time"), titleTokens("Story Time Family"))
    ).toBe(1.0)
  })
})

describe("eventFingerprint", () => {
  it("same event with different casing gives same fingerprint", () => {
    expect(eventFingerprint("Family Story Time", "2026-06-20T14:00:00.000Z", "city-1")).toBe(
      eventFingerprint("FAMILY STORY TIME", "2026-06-20T14:00:00.000Z", "city-1")
    )
  })

  it("same event with trailing whitespace gives same fingerprint", () => {
    expect(eventFingerprint("Family Story Time", "2026-06-20T14:00:00.000Z", "city-1")).toBe(
      eventFingerprint("  Family Story Time  ", "2026-06-20T14:00:00.000Z", "city-1")
    )
  })

  it("minute precision — same minute different seconds match", () => {
    expect(eventFingerprint("Story Time", "2026-06-20T14:00:00.000Z", "city-1")).toBe(
      eventFingerprint("Story Time", "2026-06-20T14:00:59.999Z", "city-1")
    )
  })

  it("different cities produce different fingerprints", () => {
    expect(eventFingerprint("Story Time", "2026-06-20T14:00:00.000Z", "city-1")).not.toBe(
      eventFingerprint("Story Time", "2026-06-20T14:00:00.000Z", "city-2")
    )
  })

  it("null cityId encoded as 'null'", () => {
    expect(
      eventFingerprint("Story Time", "2026-06-20T14:00:00.000Z", null).startsWith("null::")
    ).toBe(true)
  })

  it("different minutes produce different fingerprints", () => {
    expect(eventFingerprint("Story Time", "2026-06-20T14:00:00.000Z", "city-1")).not.toBe(
      eventFingerprint("Story Time", "2026-06-20T14:01:00.000Z", "city-1")
    )
  })
})

describe("isCrossSourceDuplicate", () => {
  it("exact fingerprint match returns true", () => {
    expect(
      isCrossSourceDuplicate(
        "Family Story Time",
        "2026-06-20T14:00:00.000Z",
        "Family Story Time",
        "2026-06-20T14:00:00.000Z",
        "city-1"
      )
    ).toBe(true)
  })

  it("fingerprint match despite different casing", () => {
    expect(
      isCrossSourceDuplicate(
        "FAMILY STORY TIME",
        "2026-06-20T14:00:00.000Z",
        "family story time",
        "2026-06-20T14:00:00.000Z",
        "city-1"
      )
    ).toBe(true)
  })

  it("partial overlap above custom threshold matches", () => {
    expect(
      isCrossSourceDuplicate(
        "alpha beta charlie",
        "2026-06-20T10:00:00.000Z",
        "alpha beta delta",
        "2026-06-20T10:30:00.000Z",
        "city-1",
        0.5
      )
    ).toBe(true)
  })

  it("fuzzy title match within three hours is a duplicate", () => {
    expect(
      isCrossSourceDuplicate(
        "Art Workshop",
        "2026-06-20T10:00:00.000Z",
        "Art Workshop for Families",
        "2026-06-20T13:00:00.000Z",
        "city-1",
        0.5
      )
    ).toBe(true)
  })

  it("fuzzy title match exactly four hours apart is a duplicate", () => {
    expect(
      isCrossSourceDuplicate(
        "Art Workshop",
        "2026-06-20T10:00:00.000Z",
        "Art Workshop for Families",
        "2026-06-20T14:00:00.000Z",
        "city-1",
        0.5
      )
    ).toBe(true)
  })

  it("fuzzy title match five hours apart is not a duplicate", () => {
    expect(
      isCrossSourceDuplicate(
        "Art Workshop",
        "2026-06-20T10:00:00.000Z",
        "Art Workshop for Families",
        "2026-06-20T15:00:00.000Z",
        "city-1",
        0.5
      )
    ).toBe(false)
  })

  it("malformed fuzzy dates are not duplicates", () => {
    expect(
      isCrossSourceDuplicate(
        "Art Workshop",
        "not-a-date",
        "Art Workshop for Families",
        "2026-06-20T10:00:00.000Z",
        "city-1",
        0.5
      )
    ).toBe(false)
  })

  it("below default threshold (1/3 < 0.7) is not a duplicate", () => {
    expect(
      isCrossSourceDuplicate(
        "family story",
        "2026-06-20T10:00:00.000Z",
        "family time",
        "2026-06-20T10:00:00.000Z",
        "city-1"
      )
    ).toBe(false)
  })

  it("completely disjoint titles is not a duplicate", () => {
    expect(
      isCrossSourceDuplicate(
        "Art Workshop",
        "2026-06-20T10:00:00.000Z",
        "Science Fair",
        "2026-06-20T10:00:00.000Z",
        "city-1"
      )
    ).toBe(false)
  })

  it("'Family Storytime' vs 'Storytime Family Edition' is NOT duplicate at 0.7 threshold", () => {
    // Real-world ticket example — call this out honestly: this pair will NOT be deduped.
    expect(
      isCrossSourceDuplicate(
        "Family Storytime",
        "2026-06-20T10:00:00.000Z",
        "Storytime Family Edition",
        "2026-06-20T10:00:00.000Z",
        "city-1"
      )
    ).toBe(false)
  })

  it("JACCARD_THRESHOLD const is 0.7", () => {
    expect(JACCARD_THRESHOLD).toBe(0.7)
  })
})
