// Ported verbatim from family-events-backend
// supabase/functions/scrape-source/parsers/brec_test.ts (U28).
// Deviations: Deno.test converted to vitest describe/it; local assertEquals
// helper replaced with expect; indexed event access uses optional chaining
// for noUncheckedIndexedAccess.

import { describe, expect, it } from "vitest"
import { parseBrecCalendar } from "./brec.js"

describe("parseBrecCalendar", () => {
  it("walks day-header + article siblings and emits ParsedEvents", () => {
    const html = `
      <html><body>
        <section class="events-list">
          <header class="day-header" data-day="1">
            <h2>Friday, May 1, 2026</h2>
          </header>
          <article>
            <h3>Perkins Trail Blazers</h3>
            <span class="time"> <br>all day<br> </span>
            <span class="park">Perkins Road Community Park</span>
            <span class="day-index">Day 121 of 151</span>
            <a href="/calendar/detail/perkins-trail-blazers/22908">Perkins Trail Blazers</a>
          </article>
          <article>
            <h3>Busy Bodies</h3>
            <span class="time">8:30 AM <br>-<br> 9:30 AM</span>
            <span class="park">Independence Community Park</span>
            <a href="/calendar/detail/busy-bodies/24998">Busy Bodies</a>
          </article>
          <header class="day-header" data-day="2">
            <h2>Saturday, May 2, 2026</h2>
          </header>
          <article>
            <h3>Bridge Club</h3>
            <span class="time">9:00 AM <br>-<br> 3:00 PM</span>
            <span class="park">Anna T. Jordan Community Park</span>
            <a href="/calendar/detail/bridge-club/25114">Bridge Club</a>
          </article>
        </section>
      </body></html>
    `

    const events = parseBrecCalendar(html, "https://www.brec.org/calendar", "America/Chicago")
    expect(events.length).toBe(3)

    const [first, second, third] = events
    expect(first?.title).toBe("Perkins Trail Blazers")
    expect(first?.venueName).toBe("Perkins Road Community Park")
    expect(first?.sourceUrl).toBe(
      "https://www.brec.org/calendar/detail/perkins-trail-blazers/22908"
    )
    // all-day -> 00:00 local start, 23:59 local end. Chicago is UTC-5 in May (CDT).
    expect(first?.startDatetime).toBe("2026-05-01T05:00:00.000Z")
    expect(first?.endDatetime).toBe("2026-05-02T04:59:00.000Z")

    expect(second?.title).toBe("Busy Bodies")
    expect(second?.startDatetime).toBe("2026-05-01T13:30:00.000Z")
    expect(second?.endDatetime).toBe("2026-05-01T14:30:00.000Z")

    expect(third?.title).toBe("Bridge Club")
    expect(third?.venueName).toBe("Anna T. Jordan Community Park")
    expect(third?.startDatetime).toBe("2026-05-02T14:00:00.000Z")
    expect(third?.endDatetime).toBe("2026-05-02T20:00:00.000Z")
  })

  it("parses flat articles from category snippet API", () => {
    const html = `
      <html><body>
        <article class="extended">
          <h2>Monday, June 1, 2026</h2>
          <h3>BREC T-Ball</h3>
          <span class="time">6:00 PM <br>-<br> 9:00 PM</span>
          <span class="park">Hartley/Vey Sports Park (Oak Villa)</span>
          <a href="/calendar/detail/brec-tball/21546">BREC T-Ball</a>
        </article>
        <article class="extended">
          <h2>Monday, June 1, 2026</h2>
          <h3>BREC Coach Pitch</h3>
          <span class="time">6:00 PM <br>-<br> 9:00 PM</span>
          <span class="park">Hartley/Vey Sports Park (Oak Villa)</span>
          <a href="/calendar/detail/brec-coach-pitch/21562">BREC Coach Pitch</a>
        </article>
        <article class="extended">
          <h2>Tuesday, June 2, 2026</h2>
          <h3>BREC Girls Fast Pitch Softball</h3>
          <span class="time">6:00 PM <br>-<br> 9:00 PM</span>
          <span class="park">Hartley/Vey Sports Park (Oak Villa)</span>
          <a href="/calendar/detail/brec-girls-fast-pitch-softball/21595">BREC Girls Fast Pitch Softball</a>
        </article>
      </body></html>
    `
    const events = parseBrecCalendar(
      html,
      "https://www.brec.org/calendar/category/KidsCalendar",
      "America/Chicago"
    )
    expect(events.length).toBe(3)

    expect(events[0]?.title).toBe("BREC T-Ball")
    expect(events[0]?.venueName).toBe("Hartley/Vey Sports Park (Oak Villa)")
    expect(events[0]?.sourceUrl).toBe("https://www.brec.org/calendar/detail/brec-tball/21546")
    // 6 PM CDT (UTC-5) = 23:00 UTC
    expect(events[0]?.startDatetime).toBe("2026-06-01T23:00:00.000Z")
    expect(events[0]?.endDatetime).toBe("2026-06-02T02:00:00.000Z")

    expect(events[1]?.title).toBe("BREC Coach Pitch")
    expect(events[2]?.title).toBe("BREC Girls Fast Pitch Softball")
    // June 2 at 6 PM CDT = 23:00 UTC
    expect(events[2]?.startDatetime).toBe("2026-06-02T23:00:00.000Z")
  })

  it("returns [] when no events-list and no articles present", () => {
    const events = parseBrecCalendar(
      "<html><body><div>nothing</div></body></html>",
      "https://www.brec.org/calendar"
    )
    expect(events.length).toBe(0)
  })

  it("drops articles preceding the first day-header", () => {
    const html = `
      <html><body>
        <section class="events-list">
          <article>
            <h3>Orphan</h3>
            <span class="time">9:00 AM</span>
            <a href="/calendar/detail/orphan/1">x</a>
          </article>
          <header class="day-header" data-day="1"><h2>Friday, May 1, 2026</h2></header>
          <article>
            <h3>Adopted</h3>
            <span class="time">10:00 AM</span>
            <a href="/calendar/detail/adopted/2">x</a>
          </article>
        </section>
      </body></html>
    `
    const events = parseBrecCalendar(html, "https://www.brec.org/calendar", "America/Chicago")
    expect(events.length).toBe(1)
    expect(events[0]?.title).toBe("Adopted")
  })
})
