import { describe, expect, it } from "vitest"

import { dateStampToWallClockIso, parseDateFromText, wallClockToIso } from "./date.js"

// parseDateFromText cases ported from family-events-backend
// scrape-source/lib/date_test.ts (U28); wallClockToIso cases added here to
// cover the DST-boundary math the upstream file left untested.

describe("parseDateFromText", () => {
  it("returns null when no date is present", () => {
    expect(parseDateFromText("no date here")).toBeNull()
  })

  it("parses month-name date strings", () => {
    const parsed = parseDateFromText("Event starts Apr 15, 2026 at 7pm")
    expect(parsed).not.toBeNull()
    expect(parsed).toMatch(/^2026-04-15T/)
  })
})

describe("wallClockToIso", () => {
  it("converts a CDT wall-clock time to UTC", () => {
    // 2026-06-01 10:00 America/Chicago is UTC-5 (CDT) → 15:00Z
    expect(
      wallClockToIso({ year: 2026, month: 6, day: 1, hour: 10, minute: 0 }, "America/Chicago")
    ).toBe("2026-06-01T15:00:00.000Z")
  })

  it("converts a CST wall-clock time to UTC", () => {
    // 2026-01-15 10:00 America/Chicago is UTC-6 (CST) → 16:00Z
    expect(
      wallClockToIso({ year: 2026, month: 1, day: 15, hour: 10, minute: 0 }, "America/Chicago")
    ).toBe("2026-01-15T16:00:00.000Z")
  })

  it("falls back to UTC on an unknown timezone by default", () => {
    expect(wallClockToIso({ year: 2026, month: 6, day: 1, hour: 10, minute: 0 }, "Not/AZone")).toBe(
      "2026-06-01T10:00:00.000Z"
    )
  })

  it("returns null on an unknown timezone when fallback is null", () => {
    expect(
      wallClockToIso({ year: 2026, month: 6, day: 1, hour: 10, minute: 0 }, "Not/AZone", {
        fallback: "null",
      })
    ).toBeNull()
  })
})

describe("dateStampToWallClockIso", () => {
  it("converts a compact YYYYMMDD stamp with wall-clock time", () => {
    expect(dateStampToWallClockIso("20260601", 10, 30, "America/Chicago")).toBe(
      "2026-06-01T15:30:00.000Z"
    )
  })

  it("returns null for a malformed stamp", () => {
    expect(dateStampToWallClockIso("2026-06-01", 10, 30, "America/Chicago")).toBeNull()
  })
})
