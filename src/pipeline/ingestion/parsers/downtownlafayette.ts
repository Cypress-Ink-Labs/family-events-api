// Ported verbatim from family-events-backend
// supabase/functions/scrape-source/parsers/downtownlafayette.ts (U28).
// Deviations: @b-fuze/deno-dom replaced with linkedom; regex-group index access
// gained an optional-chaining guard for noUncheckedIndexedAccess (behavior
// unchanged). Restructured into named helpers to satisfy the repo complexity
// gate (PR #15 review); logic unchanged, fixture tests pin behavior. A minimal
// structural Element type is declared locally for the helper signatures (same
// approach as brec.ts).

// Downtown Lafayette (DDA) event parser.
//
// The site is a Webflow CMS build with Finsweet CMS Filter. Events are embedded
// in the static HTML as w-dyn-item cards — no JS execution needed. Each card
// exposes: month (abbrev), day number, day-of-week, time range, title
// (aria-label on the absolute-link anchor), venue (c-card-subtext), image,
// and a relative href (/event/<slug>). Year is inferred from the current date
// (if the parsed month/day is in the past by more than ~30 days it is assumed
// to be next year).
//
// Card HTML structure:
//   <div class="c-card-wrap w-dyn-item">
//     <div class="c-card">
//       <a aria-label="Event Title" href="/event/slug" class="c-abso-link ..."/>
//       <div class="c-card-img">
//         <img class="g_visual_img ..." src="https://cdn.prod.website-files.com/..."/>
//       </div>
//       <div class="c-card-infowrap">
//         <div class="c-card-cal">
//           <div class="c-card-subtitle ...">May</div>
//           <div class="c-card-title ...">27</div>
//           <div class="c-card-subtitle ...">Wed</div>
//         </div>
//         <div>
//           <div class="c-card-timewrap">
//             <div class="c-card-subtitle">6:00 pm</div>
//             <div class="c-card-subtitle">-</div>
//             <div class="c-card-subtitle">8:00 pm</div>
//           </div>
//           <h2 class="c-card-title ...">Event Title</h2>
//           <div class="c-card-subtext">Venue Name</div>
//         </div>
//       </div>
//     </div>
//   </div>

import { DOMParser } from "linkedom"
import { cleanDescription, extractPrice } from "../parsing.js"
import { validateExternalUrl } from "../url-validation.js"
import { wallClockToIso } from "../date.js"
import type { ParsedEvent } from "../types.js"
import type { SourceParser } from "./_lib/types.js"

const BASE_URL = "https://www.downtownlafayette.org"

type Element = {
  getAttribute(name: string): string | null
  readonly textContent: string | null
  querySelector(selectors: string): Element | null
  querySelectorAll(selectors: string): ArrayLike<Element>
}

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
}

function parseClock(raw: string): { hour: number; minute: number } | null {
  const match = raw.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i)
  if (!match) return null
  let hour = Number(match[1])
  const minute = match[2] ? Number(match[2]) : 0
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null
  const period = match[3]?.toLowerCase()
  if (period === "pm" && hour !== 12) hour += 12
  if (period === "am" && hour === 12) hour = 0
  return { hour, minute }
}

/**
 * Infer the 4-digit year for a month/day pair by using `now` as the anchor.
 * If the date (in the current year) is more than 30 days in the past, we
 * assume next year — handles events scraped near year-end.
 */
function inferYear(month: number, day: number, now: Date): number {
  const thisYear = now.getFullYear()
  const candidate = new Date(thisYear, month, day)
  // Allow up to 30 days in the past to handle the "last month" edge case
  if (candidate.getTime() >= now.getTime() - 30 * 86_400_000) {
    return thisYear
  }
  return thisYear + 1
}

function extractTitleAndSourceUrl(
  card: Element
): { title: string; sourceUrl: string | null } | null {
  // Title: prefer aria-label on the absolute-link; fall back to h2 text
  const absLink = card.querySelector(".c-abso-link")
  const title =
    absLink?.getAttribute("aria-label")?.trim() ?? card.querySelector("h2")?.textContent?.trim()
  if (!title) return null

  // Source URL
  const href = absLink?.getAttribute("href")?.trim() ?? null
  const sourceUrl = href ? (href.startsWith("http") ? href : `${BASE_URL}${href}`) : null

  return { title, sourceUrl }
}

function extractCalendarDate(
  card: Element,
  now: Date
): { year: number; month: number; day: number } | null {
  // Month / day from the cal block
  const calBlock = card.querySelector(".c-card-cal")
  const monthText = calBlock
    ?.querySelector(".c-card-subtitle")
    ?.textContent?.trim()
    ?.toLowerCase()
    ?.slice(0, 3)
  const dayText = calBlock?.querySelector(".c-card-title")?.textContent?.trim()
  if (!monthText || !dayText) return null
  const month = MONTHS[monthText]
  if (month === undefined) return null
  const day = Number(dayText)
  if (!Number.isFinite(day) || day < 1 || day > 31) return null

  return { year: inferYear(month, day, now), month, day }
}

function extractDatetimes(
  card: Element,
  date: { year: number; month: number; day: number }
): { startDatetime: string; endDatetime: string | null } | null {
  const { year, month, day } = date

  // Time range from c-card-timewrap
  const timeEl = card.querySelectorAll(".c-card-timewrap .c-card-subtitle")
  const startRaw = timeEl[0]?.textContent?.trim() ?? ""
  const endRaw = timeEl[2]?.textContent?.trim() ?? ""
  const startClock = parseClock(startRaw)
  const endClock = parseClock(endRaw)

  const startHour = startClock?.hour ?? 0
  const startMin = startClock?.minute ?? 0
  const startDatetime = wallClockToIso(
    { year, month: month + 1, day, hour: startHour, minute: startMin, second: 0 },
    "America/Chicago",
    { fallback: "null" }
  )
  if (!startDatetime) return null

  let endDatetime: string | null = null
  if (endClock) {
    endDatetime =
      wallClockToIso(
        { year, month: month + 1, day, hour: endClock.hour, minute: endClock.minute, second: 0 },
        "America/Chicago",
        { fallback: "null" }
      ) ?? null
  }

  return { startDatetime, endDatetime }
}

function extractImageUrl(card: Element): string | null {
  // Image: g_visual_img src
  const imgEl = card.querySelector("img.g_visual_img")
  const imgSrc = imgEl?.getAttribute("src")?.trim() ?? null
  return imgSrc && validateExternalUrl(imgSrc).ok ? imgSrc : null
}

function parseCard(card: Element, now: Date): ParsedEvent | null {
  const titleAndUrl = extractTitleAndSourceUrl(card)
  if (!titleAndUrl) return null
  const { title, sourceUrl } = titleAndUrl

  const calDate = extractCalendarDate(card, now)
  if (!calDate) return null

  const datetimes = extractDatetimes(card, calDate)
  if (!datetimes) return null

  // Venue: c-card-subtext
  const venue = card.querySelector(".c-card-subtext")?.textContent?.trim() ?? null

  const imageUrl = extractImageUrl(card)

  // Description is not available on the listing page — use title as placeholder
  const description = title
  const priceInfo = extractPrice(description)

  return {
    title,
    description: cleanDescription(description).slice(0, 500),
    startDatetime: datetimes.startDatetime,
    endDatetime: datetimes.endDatetime,
    venueName: venue,
    address: venue,
    sourceUrl,
    imageUrl,
    images: imageUrl ? [imageUrl] : [],
    price: priceInfo.price,
    isFree: priceInfo.isFree,
  }
}

export function parseDowntownLafayetteEvents(html: string, now: Date = new Date()): ParsedEvent[] {
  const parser = new DOMParser()
  const doc = parser.parseFromString(html, "text/html")
  if (!doc) return []

  const events: ParsedEvent[] = []
  const seenKeys = new Set<string>()

  // Each event card is a div with class "c-card-wrap w-dyn-item"
  for (const card of doc.querySelectorAll(".c-card-wrap.w-dyn-item")) {
    const event = parseCard(card, now)
    if (!event) continue

    const key = `${event.title.toLowerCase()}::${event.startDatetime}`
    if (seenKeys.has(key)) continue
    seenKeys.add(key)

    events.push(event)
  }

  return events
}

export const downtownLafayetteParser: SourceParser<"downtownlafayette"> = {
  type: "downtownlafayette",
  async fetchArtifact(source, ctx) {
    const html = await ctx.fetchText(source.url, {
      accept: "text/html,*/*",
    })
    return { url: source.url, contentType: "text/html", body: html }
  },
  extractEvents(_source, artifact) {
    return Promise.resolve(parseDowntownLafayetteEvents(artifact.body))
  },
}
