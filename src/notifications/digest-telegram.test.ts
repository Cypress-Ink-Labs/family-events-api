import { describe, expect, it } from "vitest"

import type { DigestEvent } from "./digest-html.js"
import { renderDigestTelegram } from "./digest-telegram.js"

const event: DigestEvent = {
  id: "event-1",
  title: "<b>Family</b> & fun",
  startDatetime: "2026-09-06T02:00:00Z",
  venueName: "<i>Park</i>",
  address: null,
  isFree: true,
  price: null,
  images: [],
  explanation: "nearby & great age match",
}

describe("renderDigestTelegram", () => {
  it("renders escaped legacy-style HTML with Chicago dates", () => {
    const result = renderDigestTelegram({
      user: { displayName: "Alex & Jo", cityName: "Chicago" },
      events: [event],
      appUrl: "https://family.example.com/",
    })
    expect(result).toContain("<b>Hi Alex &amp; Jo, your weekend in Chicago!</b>")
    expect(result).toContain("Family &amp; fun</a>")
    expect(result).toContain("Sat, Sep 5 · Park · Free")
    expect(result).toContain("<i>nearby &amp; great age match</i>")
    expect(result).not.toContain("<b>Family</b>")
  })

  it("keeps complete markup and the footer within Telegram's message limit", () => {
    const huge = '🧒<&"'.repeat(2000)
    const result = renderDigestTelegram({
      user: { displayName: huge, cityName: huge },
      events: Array.from({ length: 100 }, (_, index) => ({
        ...event,
        id: String(index),
        title: huge,
        venueName: huge,
        explanation: huge,
      })),
      appUrl: "https://family.example.com",
    })
    expect(result.length).toBeLessThanOrEqual(4096)
    expect(result).toContain("…")
    expect(result.endsWith('<a href="https://family.example.com">→ Browse all events</a>')).toBe(
      true
    )
    expect(result.match(/<a /g)?.length).toBe(result.match(/<\/a>/g)?.length)
    expect(() => encodeURIComponent(result)).not.toThrow()
  })
})
