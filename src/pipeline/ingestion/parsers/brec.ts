// Ported verbatim from family-events-backend
// supabase/functions/scrape-source/parsers/brec.ts (U28).
// Deviations: @b-fuze/deno-dom replaced with linkedom; linkedom does not export
// a usable Element type under this tsconfig, so a minimal structural Element
// type is declared locally. Regex-group index accesses gained `?? ""` /
// optional-chaining guards for noUncheckedIndexedAccess (behavior unchanged).

import { DOMParser } from "linkedom"
import { cleanDescription, extractPrice, normalizeExtractedText, stripHtml } from "../parsing.js"
import { validateExternalUrl } from "../url-validation.js"
import { wallClockToIso } from "../date.js"
import type { ParsedEvent } from "../types.js"
import type { SourceParser } from "./_lib/types.js"

// Minimal structural typing for DOM elements: linkedom's exported `Element`
// is a runtime facade whose declaration (`function Element(): void`) cannot be
// used as a type.
type Element = {
  readonly tagName: string
  readonly textContent: string | null
  readonly classList: { contains(token: string): boolean }
  readonly children: Iterable<Element>
  querySelector(selectors: string): Element | null
  querySelectorAll(selectors: string): Iterable<Element>
  getAttribute(name: string): string | null
}

const MONTHS: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
}

function parseDayHeading(text: string): { y: number; m: number; d: number } | null {
  // Example: "Friday, May 1, 2026"
  const match = text.match(/(?:^|,\s*)([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/)
  if (!match) return null
  const month = MONTHS[match[1]?.toLowerCase() ?? ""]
  if (month === undefined) return null
  const day = Number(match[2])
  const year = Number(match[3])
  if (!Number.isFinite(day) || !Number.isFinite(year)) return null
  return { y: year, m: month, d: day }
}

function parseClock(value: string): { hour: number; minute: number } | null {
  const match = value.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m?\.?$/i)
  if (!match) return null
  let hour = Number(match[1])
  const minute = match[2] ? Number(match[2]) : 0
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null
  const period = match[3]?.toLowerCase()
  if (period === "p" && hour !== 12) hour += 12
  if (period === "a" && hour === 12) hour = 0
  return { hour, minute }
}

function brecWallClockToIso(
  y: number,
  m: number,
  d: number,
  hour: number,
  minute: number,
  timeZone: string
): string {
  return wallClockToIso({ year: y, month: m + 1, day: d, hour, minute }, timeZone)
}

function parseTimeRange(
  date: { y: number; m: number; d: number },
  raw: string,
  timeZone: string
): { startDatetime: string; endDatetime: string | null } {
  // BREC formats:
  //   "all day"
  //   "7:30 AM <br>-<br> 3:30 PM"  -> already br-stripped by stripHtml/normalize
  //   "9:00 AM"
  const normalized = normalizeExtractedText(raw).replace(/\s+/g, " ").trim()
  if (!normalized || /^all\s*day$/i.test(normalized)) {
    return {
      startDatetime: brecWallClockToIso(date.y, date.m, date.d, 0, 0, timeZone),
      endDatetime: brecWallClockToIso(date.y, date.m, date.d, 23, 59, timeZone),
    }
  }
  const [rawStart, rawEnd] = normalized.split(/\s*(?:-|–|—|to)\s*/i)
  const startClock = parseClock(rawStart ?? "")
  if (!startClock) {
    return {
      startDatetime: brecWallClockToIso(date.y, date.m, date.d, 0, 0, timeZone),
      endDatetime: null,
    }
  }
  const startDatetime = brecWallClockToIso(
    date.y,
    date.m,
    date.d,
    startClock.hour,
    startClock.minute,
    timeZone
  )
  const endClock = parseClock(rawEnd ?? "")
  let endDatetime = endClock
    ? brecWallClockToIso(date.y, date.m, date.d, endClock.hour, endClock.minute, timeZone)
    : null
  if (endDatetime && new Date(endDatetime).getTime() <= new Date(startDatetime).getTime()) {
    endDatetime = new Date(new Date(endDatetime).getTime() + 24 * 60 * 60 * 1000).toISOString()
  }
  return { startDatetime, endDatetime }
}

function resolveUrl(href: string | null, base: string): string | null {
  if (!href) return null
  try {
    return new URL(href, base).toString()
  } catch {
    return null
  }
}

function extractArticleImage(article: Element, base: string): string | null {
  const img = article.querySelector("img")
  const src = img?.getAttribute("src")
  if (!src) return null
  const url = resolveUrl(src, base)
  return url && validateExternalUrl(url).ok ? url : null
}

function parseArticle(
  article: Element,
  date: { y: number; m: number; d: number },
  sourceUrl: string,
  timeZone: string,
  seenKeys: Set<string>,
  events: ParsedEvent[]
): void {
  const title = stripHtml(article.querySelector("h3")?.textContent ?? "").trim()
  if (!title) return

  const timeText = article.querySelector(".time")?.textContent ?? ""
  const { startDatetime, endDatetime } = parseTimeRange(date, timeText, timeZone)

  const venueName = stripHtml(article.querySelector(".park")?.textContent ?? "").trim() || null

  const linkHref = article.querySelector("a[href]")?.getAttribute("href") ?? null
  const eventUrl = resolveUrl(linkHref, sourceUrl)

  const dayIndex = stripHtml(article.querySelector(".day-index")?.textContent ?? "").trim()
  const description = cleanDescription([venueName, dayIndex].filter(Boolean).join(" — ")) || title

  const imageUrl = extractArticleImage(article, sourceUrl)
  const priceInfo = extractPrice(description)

  const key = `${eventUrl ?? title}::${startDatetime}`
  if (seenKeys.has(key)) return
  seenKeys.add(key)

  events.push({
    title,
    description: description.slice(0, 500),
    startDatetime,
    endDatetime,
    venueName,
    address: venueName,
    sourceUrl: eventUrl,
    imageUrl,
    images: imageUrl ? [imageUrl] : [],
    price: priceInfo.price,
    isFree: priceInfo.isFree,
  })
}

export function parseBrecCalendar(
  html: string,
  sourceUrl: string,
  timeZone = "America/Chicago"
): ParsedEvent[] {
  const doc = new DOMParser().parseFromString(html, "text/html")
  if (!doc) return []

  const events: ParsedEvent[] = []
  const seenKeys = new Set<string>()

  // Standard path: .events-list container interleaves <header class="day-header">
  // with sibling <article> blocks until the next day-header.
  const lists = doc.querySelectorAll(".events-list")
  for (const list of lists) {
    let currentDate: { y: number; m: number; d: number } | null = null
    for (const child of (list as Element).children) {
      if (child.classList.contains("day-header")) {
        const heading = child.querySelector("h2")?.textContent ?? ""
        currentDate = parseDayHeading(heading)
        continue
      }
      if (child.tagName?.toLowerCase() !== "article" || !currentDate) {
        continue
      }
      parseArticle(child as Element, currentDate, sourceUrl, timeZone, seenKeys, events)
    }
  }

  // Fallback: BREC category snippet API returns flat <article> elements
  // where each article embeds its own <h2> date heading instead of using
  // separate .day-header siblings.
  if (events.length === 0) {
    const articles = doc.querySelectorAll("article")
    for (const el of articles) {
      const article = el as Element
      const heading = article.querySelector("h2")?.textContent ?? ""
      const date = parseDayHeading(heading)
      if (!date) continue
      parseArticle(article, date, sourceUrl, timeZone, seenKeys, events)
    }
  }

  return events
}

const BREC_SNIPPET_PER_PAGE = 20
const BREC_SNIPPET_MAX_PAGES = 10

export const brecParser: SourceParser<"brec"> = {
  type: "brec",
  async fetchArtifact(source, ctx) {
    const html = await ctx.fetchText(source.url, {
      accept: "text/html,application/xhtml+xml,*/*",
    })

    // BREC category pages (e.g. /calendar/category/KidsCalendar) render an
    // empty .events-list container and load events via AJAX.  Detect the
    // empty container, extract the category ID, and fetch the snippet API
    // that returns the actual event markup.
    const catMatch = html.match(
      /id="container-events"[^>]*\bcategory-id="(\d+)"[^>]*\bnum-events="(\d+)"/
    )
    if (catMatch) {
      const categoryId = catMatch[1] ?? ""
      const numEvents = Number(catMatch[2])
      if (numEvents > 0) {
        const totalPages = Math.min(
          Math.ceil(numEvents / BREC_SNIPPET_PER_PAGE),
          BREC_SNIPPET_MAX_PAGES
        )
        const origin = new URL(source.url).origin
        const fragments: string[] = []
        for (let page = 1; page <= totalPages; page++) {
          const snippetUrl = `${origin}/?action=calendar.category_events.snip&categoryID=${categoryId}&pageNum=${page}`
          fragments.push(
            await ctx.fetchText(snippetUrl, {
              accept: "text/html,application/xhtml+xml,*/*",
            })
          )
        }
        return {
          url: source.url,
          contentType: "text/html",
          body: `<html><body>${fragments.join("\n")}</body></html>`,
        }
      }
    }

    return { url: source.url, contentType: "text/html", body: html }
  },
  extractEvents(source, artifact, ctx) {
    return Promise.resolve(
      parseBrecCalendar(artifact.body, artifact.url || source.url, ctx.timezone)
    )
  },
}
