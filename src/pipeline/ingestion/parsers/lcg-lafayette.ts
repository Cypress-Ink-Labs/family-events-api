// Ported verbatim from family-events-backend
// supabase/functions/scrape-source/parsers/lcg-lafayette.ts (U28).
// Deviations: @b-fuze/deno-dom replaced with linkedom; upstream's unused
// MONTHS table is dropped (this repo's lint errors on unused declarations).

// Lafayette Consolidated Government (LCG) event parser.
//
// The site uses Vision CMS. Events are embedded in the static HTML as
// <li class="gs-feed-list-item"> nodes inside <ul class="gs-feed-list-events">.
// Each item exposes: month (abbrev), day number, event title, and a full
// absolute event URL. The URL slug encodes the datetime:
//   https://events.lafayettela.gov/default/detail/YYYY-MM-DD-HHMM-Slug
// e.g. "2026-05-27-1730-Disaster-Ready-Workshop" → 2026-05-27 17:30
//
// No description, venue, or image is available on the listing page.
// These are primarily government/civic events (city council, workshops, camps)
// and some community/family programming from the Parks, Arts, Recreation >/dev/null 2>&1 &
// Culture (PARC) department.
//
// HTML structure:
//   <ul class="gs-feed-list-events">
//     <li class="gs-feed-list-item ...">
//       <span class="gs-feed-list-month">May</span>
//       <span class="gs-feed-list-day">27</span>
//       <a href="https://events.lafayettela.gov/default/detail/2026-05-27-1730-..."
//          class="gs-feed-list-title">Event Title</a>
//     </li>
//     ...
//   </ul>

import { DOMParser } from "linkedom"
import { cleanDescription, extractPrice } from "../parsing.js"
import { wallClockToIso } from "../date.js"
import type { ParsedEvent } from "../types.js"
import type { SourceParser } from "./_lib/types.js"

/**
 * Extract datetime from an LCG event URL slug.
 * Slug format: YYYY-MM-DD-HHMM-Title-Slug
 * Returns ISO string or null on parse failure.
 */
export function parseLcgEventUrl(url: string): {
  startDatetime: string | null
  year: number | null
  month: number | null
  day: number | null
} {
  // Match: .../YYYY-MM-DD-HHMM-...
  const match = url.match(/\/(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})-/)
  if (!match) return { startDatetime: null, year: null, month: null, day: null }

  const [, yearStr, monthStr, dayStr, hourStr, minStr] = match
  const year = Number(yearStr)
  const month = Number(monthStr)
  const day = Number(dayStr)
  const hour = Number(hourStr)
  const minute = Number(minStr)

  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute)
  ) {
    return { startDatetime: null, year: null, month: null, day: null }
  }

  const startDatetime =
    wallClockToIso({ year, month, day, hour, minute, second: 0 }, "America/Chicago", {
      fallback: "null",
    }) ?? null

  return { startDatetime, year, month, day }
}

export function parseLcgEvents(html: string): ParsedEvent[] {
  const parser = new DOMParser()
  const doc = parser.parseFromString(html, "text/html")
  if (!doc) return []

  const events: ParsedEvent[] = []
  const seenKeys = new Set<string>()

  for (const item of doc.querySelectorAll("li.gs-feed-list-item")) {
    // Title + source URL from the anchor
    const anchor = item.querySelector("a.gs-feed-list-title")
    const title = anchor?.textContent?.trim()
    const href = anchor?.getAttribute("href")?.trim() ?? null
    if (!title || !href) continue

    const { startDatetime } = parseLcgEventUrl(href)
    if (!startDatetime) continue

    const description = title
    const priceInfo = extractPrice(description)

    const key = `${title.toLowerCase()}::${startDatetime}`
    if (seenKeys.has(key)) continue
    seenKeys.add(key)

    events.push({
      title,
      description: cleanDescription(description).slice(0, 500),
      startDatetime,
      endDatetime: null,
      venueName: null,
      address: null,
      sourceUrl: href,
      imageUrl: null,
      images: [],
      price: priceInfo.price,
      isFree: priceInfo.isFree,
    })
  }

  return events
}

export const lcgLafayetteParser: SourceParser<"lcglafayette"> = {
  type: "lcglafayette",
  async fetchArtifact(source, ctx) {
    const html = await ctx.fetchText(source.url, {
      accept: "text/html,*/*",
    })
    return { url: source.url, contentType: "text/html", body: html }
  },
  extractEvents(_source, artifact) {
    return Promise.resolve(parseLcgEvents(artifact.body))
  },
}
