// Ported verbatim from family-events-backend supabase/functions/scrape-source/parsers/localhop_test.ts (U28).
// Deviations: Deno.test converted to vitest describe/it; assertEquals converted to expect
// equivalents; noUncheckedIndexedAccess handled with optional chaining on indexed access.

import { describe, expect, it } from "vitest"

import { parseLocalHopEvents } from "./localhop.js"

describe("localhop parser", () => {
  it("parseLocalHopEvents maps EventInstance API rows to parsed events", () => {
    const json = {
      results: [
        {
          objectId: "w0HShsCRHs",
          standardStartDate: { __type: "Date", iso: "2026-06-03T15:30:00.000Z" },
          standardEndDate: { __type: "Date", iso: "2026-06-03T16:00:00.000Z" },
          event: {
            name: "Toddler Time Storytime",
            description: "<p>Storytime for babies walking to age 2.</p>",
            slug: "toddler-time-storytime",
            address: {
              place: "East Baton Rouge Parish Library Bluebonnet Regional",
              address1: "9200 Bluebonnet Boulevard",
              city: "Baton Rouge",
              state: "LA",
              postalCode: "70810",
            },
            photo: {
              url: "https://localhop-prod.s3.amazonaws.com/uploads/storytime.png",
            },
          },
          slug: "toddler-time-storytime",
        },
      ],
    }

    const events = parseLocalHopEvents(json)

    expect(events.length).toBe(1)
    expect(events[0]?.title).toBe("Toddler Time Storytime")
    expect(events[0]?.description).toBe("Storytime for babies walking to age 2.")
    expect(events[0]?.startDatetime).toBe("2026-06-03T15:30:00.000Z")
    expect(events[0]?.endDatetime).toBe("2026-06-03T16:00:00.000Z")
    expect(events[0]?.venueName).toBe("East Baton Rouge Parish Library Bluebonnet Regional")
    expect(events[0]?.address).toBe("9200 Bluebonnet Boulevard, Baton Rouge, LA, 70810")
    expect(events[0]?.sourceUrl).toBe(
      "https://events.getlocalhop.com/toddler-time-storytime/event/w0HShsCRHs/"
    )
    expect(events[0]?.imageUrl).toBe("https://localhop-prod.s3.amazonaws.com/uploads/storytime.png")
  })

  it("parseLocalHopEvents skips rows without usable date or title", () => {
    const events = parseLocalHopEvents({
      results: [
        { objectId: "date-less", event: { name: "No date" } },
        {
          objectId: "title-less",
          standardStartDate: { iso: "2026-06-03T15:30:00.000Z" },
          event: {},
        },
      ],
    })

    expect(events.length).toBe(0)
  })
})
