import { describe, expect, it } from "vitest"

import type { PlannedEvent } from "../data/types.js"
import { buildExplanation, renderDigestEmail, type DigestEvent } from "./digest-html.js"

const event = (id: string, title: string): DigestEvent => ({
  id,
  title,
  startDatetime: "2026-09-04T15:00:00.000Z",
  venueName: "Main Library",
  address: null,
  isFree: true,
  price: null,
  images: [],
  explanation: "nearby · perfect weekend timing",
})

describe("digest email rendering", () => {
  it("renders event cards and current app links with escaped input", () => {
    const result = renderDigestEmail({
      user: { displayName: "Reader & Family", cityName: "Lafayette" },
      events: [event("1", "Storytime"), event("2", "Park Day"), event("3", "<script>x</script>")],
      appUrl: "https://events.example.com/",
    })

    expect(result.subject).toBe("3 family picks for your weekend")
    expect(result.html).toContain("Storytime")
    expect(result.html).toContain("Park Day")
    expect(result.html).toContain('href="https://events.example.com/account/alerts"')
    expect(result.html).toContain('src="https://events.example.com/brand/icon-192.png"')
    expect(result.html).not.toContain("<script")
    expect(result.html).not.toContain("Reader & Family")
    expect(result.html).toContain("Reader &amp; Family")
  })

  it("uses the top two factors above neutral with source-order tie breaking", () => {
    // Legacy source lines 166-196: factor labels and > 0.5 threshold.
    const row = {
      distance_score: "0.9",
      timing_score: "0.9",
      budget_score: "0.8",
      weather_score: "0.5",
    } as PlannedEvent
    expect(buildExplanation(row)).toBe("nearby · perfect weekend timing")
    expect(buildExplanation({} as PlannedEvent)).toBeNull()
  })
})
