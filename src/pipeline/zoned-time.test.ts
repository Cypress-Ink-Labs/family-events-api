import { describe, expect, it } from "vitest"

import { weekendWindowUtc, zonedDayStartUtc } from "./zoned-time.js"

// Ported from family-events-backend supabase/functions/_shared/zoned-time.test.ts

const CHICAGO = "America/Chicago"

describe("weekendWindowUtc", () => {
  it("selects the Friday-to-Monday Chicago weekend from every weekday", () => {
    const weekdays = [
      "2026-06-15T18:00:00.321Z", // Monday with milliseconds
      "2026-06-15T18:00:00Z", // Monday
      "2026-06-16T18:00:00Z", // Tuesday
      "2026-06-17T18:00:00Z", // Wednesday
      "2026-06-18T18:00:00Z", // Thursday
      "2026-06-19T18:00:00Z", // Friday
      "2026-06-20T18:00:00Z", // Saturday
      "2026-06-21T18:00:00Z", // Sunday
    ]

    for (const now of weekdays) {
      const window = weekendWindowUtc(new Date(now), CHICAGO)
      expect(window.from.toISOString()).toBe("2026-06-19T05:00:00.000Z")
      expect(window.to.toISOString()).toBe("2026-06-22T05:00:00.000Z")
    }
  })

  it("resolves target-day offsets across the spring DST transition", () => {
    const now = new Date("2026-03-07T18:00:00Z")
    const saturday = zonedDayStartUtc(now, CHICAGO, 0)
    const sunday = zonedDayStartUtc(now, CHICAGO, 1)
    const monday = zonedDayStartUtc(now, CHICAGO, 2)

    expect(saturday.toISOString()).toBe("2026-03-07T06:00:00.000Z")
    expect(sunday.toISOString()).toBe("2026-03-08T06:00:00.000Z")
    expect(monday.toISOString()).toBe("2026-03-09T05:00:00.000Z")
    expect(monday.getTime() - sunday.getTime()).toBe(23 * 60 * 60 * 1000)
  })

  it("resolves target-day offsets across the fall DST transition", () => {
    const window = weekendWindowUtc(new Date("2026-10-28T18:00:00Z"), CHICAGO)

    expect(window.from.toISOString()).toBe("2026-10-30T05:00:00.000Z")
    expect(window.to.toISOString()).toBe("2026-11-02T06:00:00.000Z")
    expect(window.to.getTime() - window.from.getTime()).toBe(73 * 60 * 60 * 1000)
  })
})
