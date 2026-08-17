// Ported verbatim from family-events-backend supabase/functions/scrape-source/parsers/website_test.ts (U28).
// Deviations: Deno.test converted to vitest describe/it, local assertEquals helper replaced with
// expect, Deno.readTextFile fixture loading replaced with node:fs readFileSync, and indexed event
// access uses optional chaining for noUncheckedIndexedAccess.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { parseWebsite } from "./website.js"

const FIXTURES = join(process.cwd(), "src", "pipeline", "ingestion", "parsers", "__fixtures__")

function readFixture(relativePath: string): string {
  return readFileSync(join(FIXTURES, relativePath), "utf8")
}

describe("website parser", () => {
  it("parseWebsite extracts schema.org Event JSON-LD and rejects date-less events", () => {
    const html = readFixture("html/events-page.html")
    const events = parseWebsite(html, "https://events.example.com/calendar")

    expect(events.length).toBe(1)
    expect(events[0]?.title).toBe("City Science Fair")
    expect(events[0]?.startDatetime).toBe("2026-08-11T15:00:00.000Z")
    expect(events[0]?.endDatetime).toBe("2026-08-11T19:00:00.000Z")
    expect(events[0]?.sourceUrl).toBe("https://events.example.com/events/science-fair")
    expect(events[0]?.venueName).toBe("Riverfront Hall")
    expect(events[0]?.address).toBe("101 Main St")
    expect(events[0]?.imageUrl).toBe("https://events.example.com/science-fair.jpg")
    expect(events[0]?.price).toBe(0)
    expect(events[0]?.isFree).toBe(true)
  })

  it("parseWebsite prefers Modern Events Calendar DOM titles and local times", () => {
    const html = `
      <html>
        <body>
          <dt class="mec-calendar-day" data-mec-cell="20260428">
            <a class="mec-monthly-tooltip event-single-link-simple" data-tooltip-content="#mec-tooltip-10562" href="/calendar-events/garden-talks-spring26/">
              <h4 class="mec-event-title">Garden Talks</h4>
            </a>
          </dt>
          <div id="mec-tooltip-10562">
            <div class="mec-tooltip-event-time"><i></i> 5:30 pm - 6:30 pm</div>
            <div class="mec-tooltip-event-desc">Garden Talks &#x1f331;
              Dig in with us this spring at Moncus Park.
              Dates: March 31, April 28, May 26Time: 5:30–6:30 PMWhat to Bring: curiosity , ...
            </div>
          </div>
          <script type="application/ld+json">
            {
              "@context": "http://schema.org",
              "@type": "Event",
              "startDate": "2026-04-28T12:30:00-05:00",
              "endDate": "2026-04-28T13:30:00-05:00",
              "description": "Garden Talks &#x1f331; Dig in with us this spring at Moncus Park. Dates: March 31, April 28, May 26Time: 5:30–6:30 PMWhat to Bring: curiosity &amp; gloves.",
              "image": "https://moncuspark.org/garden.jpg",
              "name": "Garden Talks &#x1f331; Dig in with us this spring at Moncus Park",
              "offers": { "price": "0" },
              "url": "https://moncuspark.org/calendar-events/garden-talks-spring26/"
            }
          </script>
        </body>
      </html>
    `

    const events = parseWebsite(html, "https://moncuspark.org/events/", "America/Chicago")

    expect(events.length).toBe(1)
    expect(events[0]?.title).toBe("Garden Talks")
    expect(events[0]?.startDatetime).toBe("2026-04-28T22:30:00.000Z")
    expect(events[0]?.endDatetime).toBe("2026-04-28T23:30:00.000Z")
    expect(events[0]?.description.includes("🌱")).toBe(true)
    expect(events[0]?.description.includes("May 26 Time: 5:30-6:30 PM What to Bring")).toBe(true)
    expect(events[0]?.isFree).toBe(true)
  })

  it("parseWebsite returns [] when no structured event data exists", () => {
    const events = parseWebsite(
      '<html><body><a href="/x">Link only</a></body></html>',
      "https://example.com"
    )
    expect(events.length).toBe(0)
  })

  it("parseWebsite extracts Events nested inside ItemList.itemListElement (Eventbrite shape)", () => {
    // Eventbrite serves JSON-LD as ItemList -> ListItem.item where item is @type:Event.
    // Earlier regression: parser only recursed into @graph, missed all ItemList events.
    const html = `
      <html><body>
        <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "ItemList",
          "itemListElement": [
            {
              "@type": "ListItem",
              "position": 1,
              "item": {
                "@type": "Event",
                "name": "Family Meditation",
                "startDate": "2026-05-23T15:00:00-05:00",
                "url": "https://www.eventbrite.com/e/family-meditation-tickets-1",
                "location": { "name": "Riverside Park" }
              }
            },
            {
              "@type": "ListItem",
              "position": 2,
              "item": {
                "@type": "Event",
                "name": "Kid Fest",
                "startDate": "2026-06-10T10:00:00-05:00",
                "url": "https://www.eventbrite.com/e/kid-fest-tickets-2"
              }
            }
          ]
        }
        </script>
      </body></html>
    `
    const events = parseWebsite(html, "https://www.eventbrite.com/d/la--baton-rouge/family-events/")
    expect(events.length).toBe(2)
    expect(events[0]?.title).toBe("Family Meditation")
    expect(events[0]?.sourceUrl).toBe("https://www.eventbrite.com/e/family-meditation-tickets-1")
    expect(events[1]?.title).toBe("Kid Fest")
  })

  it("parseSchemaOrgEvents reads structured PostalAddress sub-fields", () => {
    const html = `
      <html><body>
        <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "Event",
          "name": "Art Walk",
          "startDate": "2026-09-15T18:00:00-05:00",
          "location": {
            "@type": "Place",
            "name": "Acadiana Center for the Arts",
            "address": {
              "@type": "PostalAddress",
              "streetAddress": "101 W Vermilion St",
              "addressLocality": "Lafayette",
              "addressRegion": "LA",
              "postalCode": "70501"
            }
          }
        }
        </script>
      </body></html>
    `
    const events = parseWebsite(html, "https://example.com/events/")
    expect(events.length).toBe(1)
    expect(events[0]?.venueName).toBe("Acadiana Center for the Arts")
    expect(events[0]?.address).toBe("101 W Vermilion St, Lafayette, LA, 70501")
  })

  it("parseWebsite extracts Baton Rouge Zoo event cards", () => {
    const html = `
      <section>
        <h2>Special Events</h2>
        <div class="repeater-list-card-img-lg">
          <div class="repeater-list-item">
            <a href="https://brzoo.org/events-rentals/calendar/twilight-tour?occdate=2026-06-02">
              <div class="item-date">
                <b class="event-month">Jun</b>
                <b class="event-day">2</b>
              </div>
              <img data-src="https://brzoo.org/twilight.jpg" alt="Twilight Tour">
              <h3 class="repeater-list-card-img-lg-item-header">Twilight Tour</h3>
              <i class="item-time">6:00pm–7:30pm</i>
            </a>
          </div>
        </div>
      </section>
    `

    const events = parseWebsite(html, "https://brzoo.org/", "America/Chicago")

    expect(events.length).toBe(1)
    expect(events[0]?.title).toBe("Twilight Tour")
    expect(events[0]?.startDatetime).toBe("2026-06-02T23:00:00.000Z")
    expect(events[0]?.endDatetime).toBe("2026-06-03T00:30:00.000Z")
    expect(events[0]?.sourceUrl).toBe(
      "https://brzoo.org/events-rentals/calendar/twilight-tour?occdate=2026-06-02"
    )
    expect(events[0]?.imageUrl).toBe("https://brzoo.org/twilight.jpg")
  })

  it("parseWebsite extracts All-in-One Event Calendar popovers", () => {
    const html = `
      <main>
        <h1>May – June 2026</h1>
        <a class="ai1ec-event-container ai1ec-load-event" data-instance-id="809"
          href="https://perkinsrowe.com/event/sidewalk-astronomy-51/?instance_id=809">
          <div class="ai1ec-event">
            <span class="ai1ec-event-title">Sidewalk Astronomy</span>
            <span class="ai1ec-event-time">7:00 pm</span>
          </div>
        </a>
        <div class="ai1ec-popover">
          <span class="ai1ec-popup-title">
            <a href="https://perkinsrowe.com/event/sidewalk-astronomy-51/?instance_id=809">Sidewalk Astronomy</a>
            <span class="ai1ec-event-location">@ Perkins Rowe</span>
          </span>
          <div class="ai1ec-event-time">May 26 @ 7:00 pm – 9:00 pm</div>
          <div class="ai1ec-event-description">Bring your friends and get a glimpse of the sky.</div>
        </div>
      </main>
    `

    const events = parseWebsite(html, "https://perkinsrowe.com/happenings/", "America/Chicago")

    expect(events.length).toBe(1)
    expect(events[0]?.title).toBe("Sidewalk Astronomy")
    expect(events[0]?.startDatetime).toBe("2026-05-27T00:00:00.000Z")
    expect(events[0]?.endDatetime).toBe("2026-05-27T02:00:00.000Z")
    expect(events[0]?.venueName).toBe("Perkins Rowe")
  })

  it("parseWebsite extracts Squarespace summary event cards", () => {
    const html = `
      <div class="summary-item summary-item-record-type-event">
        <a href="/comingsoon/sunsetblvd" data-title="Sunset Boulevard - $5 Movie">
          <img data-src="https://images.squarespace-cdn.com/sunset.png" alt="Sunset Boulevard - $5 Movie">
        </a>
        <div class="summary-content">
          <time class="summary-metadata-item summary-metadata-item--date">May 30, 2026</time>
          <div class="summary-title">
            <a href="/comingsoon/sunsetblvd" class="summary-title-link">Sunset Boulevard - $5 Movie</a>
          </div>
        </div>
      </div>
    `

    const events = parseWebsite(html, "https://manshiptheatre.org/", "America/Chicago")

    expect(events.length).toBe(1)
    expect(events[0]?.title).toBe("Sunset Boulevard - $5 Movie")
    expect(events[0]?.startDatetime).toBe("2026-05-30T05:00:00.000Z")
    expect(events[0]?.sourceUrl).toBe("https://manshiptheatre.org/comingsoon/sunsetblvd")
    expect(events[0]?.imageUrl).toBe("https://images.squarespace-cdn.com/sunset.png")
  })
})
