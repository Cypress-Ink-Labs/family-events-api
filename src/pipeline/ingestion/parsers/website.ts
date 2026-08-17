// Ported verbatim from family-events-backend supabase/functions/scrape-source/parsers/website.ts (U28).
// Deviations: @b-fuze/deno-dom replaced with linkedom; linkedom's exported Element is typed as a
// bare facade function, so a minimal structural Element type is declared locally; strict
// noUncheckedIndexedAccess fixes for regex group access (optional chaining / ?? null fallbacks);
// firstYearFromDocument narrows to HTMLDocument for body access and falls back to documentElement
// text because linkedom leaves body empty when parsing HTML fragments (deno-dom moves fragment
// content into body); parseStructuredEvents restructured into named helpers to satisfy the repo
// complexity gate (PR #15 review); logic unchanged, fixture tests pin behavior.

import { DOMParser } from "linkedom"
import {
  cleanDescription,
  extractPrice,
  normalizeExtractedText,
  parseIsoDate,
  stripHtml,
} from "../parsing.js"
import { validateExternalUrl } from "../url-validation.js"
import { dateStampToWallClockIso, wallClockToIso } from "../date.js"
import type { ParsedEvent } from "../types.js"
import type { SourceParser } from "./_lib/types.js"

type StructuredEvent = ParsedEvent & {
  sourceUrl: string | null
}

// Minimal structural typing for the DOM element surface this parser touches (see header note).
interface Element {
  textContent: string | null
  querySelector(selector: string): Element | null
  querySelectorAll(selector: string): Iterable<Element>
  getAttribute(name: string): string | null
}

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
}

function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value
  }
  return value === null || value === undefined ? [] : [value]
}

function eventNodes(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => eventNodes(item))
  }
  if (!value || typeof value !== "object") {
    return []
  }

  const node = value as Record<string, unknown>
  const typeValues = toArray(node["@type"]).map((entry) => String(entry).toLowerCase())
  const isEvent = typeValues.some((entry) => entry === "event" || entry.endsWith(":event"))
  // Descend into common JSON-LD wrappers that nest Event objects:
  // @graph, ItemList.itemListElement[].item, mainEntity, hasPart.
  // Eventbrite uses ItemList → ListItem.item where item is @type:Event.
  const nested = [
    ...eventNodes(node["@graph"]),
    ...eventNodes(node["itemListElement"]),
    ...eventNodes(node["item"]),
    ...eventNodes(node["mainEntity"]),
    ...eventNodes(node["hasPart"]),
  ]
  return isEvent ? [node, ...nested] : nested
}

function pickText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = stripHtml(value)
    return trimmed.length > 0 ? trimmed : null
  }
  if (value && typeof value === "object") {
    const node = value as Record<string, unknown>
    return pickText(node["@value"] ?? node.name ?? node.text)
  }
  return null
}

function extractImageUrls(value: unknown): string[] {
  if (typeof value === "string") {
    return [value]
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractImageUrls(entry))
  }
  if (value && typeof value === "object") {
    const node = value as Record<string, unknown>
    return extractImageUrls(node.url ?? node.contentUrl)
  }
  return []
}

function parseClock(value: string): { hour: number; minute: number } | null {
  const match = value.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m?\.?$/i)
  if (!match) {
    return null
  }

  let hour = Number(match[1])
  const minute = match[2] ? Number(match[2]) : 0
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) {
    return null
  }

  const period = match[3]?.toLowerCase()
  if (period === "p" && hour !== 12) {
    hour += 12
  }
  if (period === "a" && hour === 12) {
    hour = 0
  }

  return { hour, minute }
}

function parseMecTimeRange(
  dateStamp: string,
  rawTime: string,
  timeZone: string
): { startDatetime: string; endDatetime: string | null } | null {
  const normalized = normalizeExtractedText(rawTime)
    .replace(/^[^\d]+/, "")
    .replace(/\s+/g, " ")
  const [rawStart, rawEnd] = normalized.split(/\s*(?:-|–|—|to)\s*/i)
  const startClock = parseClock(rawStart ?? "")
  if (!startClock) {
    return null
  }

  const startDatetime = dateStampToWallClockIso(
    dateStamp,
    startClock.hour,
    startClock.minute,
    timeZone
  )
  if (!startDatetime) {
    return null
  }

  const endClock = parseClock(rawEnd ?? "")
  let endDatetime = endClock
    ? dateStampToWallClockIso(dateStamp, endClock.hour, endClock.minute, timeZone)
    : null
  if (endDatetime && new Date(endDatetime).getTime() <= new Date(startDatetime).getTime()) {
    endDatetime = new Date(new Date(endDatetime).getTime() + 24 * 60 * 60 * 1000).toISOString()
  }

  return { startDatetime, endDatetime }
}

function normalizeUrl(value: string | null, baseUrl: string): string | null {
  if (!value) {
    return null
  }
  try {
    return new URL(value, baseUrl).toString()
  } catch {
    return null
  }
}

function validImageUrl(value: string | null, baseUrl: string): string | null {
  const normalized = normalizeUrl(value, baseUrl)
  return normalized && validateExternalUrl(normalized).ok ? normalized : null
}

function textFromFirst(root: Element, selectors: string[]): string | null {
  for (const selector of selectors) {
    const text = pickText(root.querySelector(selector)?.textContent)
    if (text) {
      return text
    }
  }
  return null
}

function attrFromFirst(root: Element, selectors: string[], attrs: string[]): string | null {
  for (const selector of selectors) {
    const node = root.querySelector(selector)
    if (!node) {
      continue
    }
    for (const attr of attrs) {
      const value = node.getAttribute(attr)
      if (value?.trim()) {
        return value.trim()
      }
    }
  }
  return null
}

function parseDateParts(
  monthText: string | null,
  dayText: string | null,
  yearText: string | null
): { year: number; month: number; day: number } | null {
  if (!monthText || !dayText || !yearText) {
    return null
  }
  const month = MONTHS[monthText.trim().toLowerCase()]
  const day = Number(dayText.trim())
  const year = Number(yearText.trim())
  if (!month || !Number.isFinite(day) || !Number.isFinite(year)) {
    return null
  }
  return { year, month, day }
}

function parseDateFromTextParts(
  rawDate: string
): { year: number; month: number; day: number } | null {
  const match = normalizeExtractedText(rawDate).match(
    /\b([A-Za-z]{3,9})\s+(\d{1,2})(?:,\s*(20\d{2}))?\b/
  )
  if (!match) {
    return null
  }
  const year = match[3] ?? String(new Date().getFullYear())
  return parseDateParts(match[1] ?? null, match[2] ?? null, year)
}

function parseIsoDateStamp(value: string | null): {
  year: number
  month: number
  day: number
} | null {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) {
    return null
  }
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  }
}

function toIsoForDateClock(
  date: { year: number; month: number; day: number },
  clock: { hour: number; minute: number },
  timeZone: string
): string {
  return wallClockToIso({ ...date, hour: clock.hour, minute: clock.minute }, timeZone)
}

function parseTimeRangeForDate(
  date: { year: number; month: number; day: number },
  rawTime: string,
  timeZone: string
): { startDatetime: string; endDatetime: string | null } | null {
  const normalized = normalizeExtractedText(rawTime)
  const [rawStart, rawEnd] = normalized.split(/\s*(?:-|–|—|to)\s*/i)
  const startClock = parseClock(rawStart ?? "")
  if (!startClock) {
    return null
  }

  const startDatetime = toIsoForDateClock(date, startClock, timeZone)
  const endClock = parseClock(rawEnd ?? "")
  let endDatetime = endClock ? toIsoForDateClock(date, endClock, timeZone) : null
  if (endDatetime && new Date(endDatetime).getTime() <= new Date(startDatetime).getTime()) {
    endDatetime = new Date(new Date(endDatetime).getTime() + 24 * 60 * 60 * 1000).toISOString()
  }

  return { startDatetime, endDatetime }
}

function parseHumanDateTimeRange(
  raw: string,
  fallbackYear: number | null,
  timeZone: string
): { startDatetime: string; endDatetime: string | null } | null {
  const normalized = normalizeExtractedText(raw)
  const match = normalized.match(
    /\b([A-Za-z]{3,9})\s+(\d{1,2})(?:,\s*(20\d{2}))?\s*@\s*(\d{1,2}(?::\d{2})?\s*[ap]\.?m?\.?)(?:\s*(?:-|to)\s*(\d{1,2}(?::\d{2})?\s*[ap]\.?m?\.?))?/i
  )
  if (!match) {
    return null
  }
  const date = parseDateParts(
    match[1] ?? null,
    match[2] ?? null,
    match[3] ?? (fallbackYear ? String(fallbackYear) : null)
  )
  if (!date) {
    return null
  }
  return parseTimeRangeForDate(date, [match[4], match[5]].filter(Boolean).join(" - "), timeZone)
}

function offerPrice(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function collectJsonLdEventNodes(
  doc: NonNullable<ReturnType<DOMParser["parseFromString"]>>
): Record<string, unknown>[] {
  const eventCandidates: Record<string, unknown>[] = []
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    const rawJson = script.textContent?.trim() ?? ""
    if (!rawJson) {
      continue
    }

    try {
      const parsed = JSON.parse(rawJson)
      eventCandidates.push(...eventNodes(parsed))
    } catch {
      continue
    }
  }
  return eventCandidates
}

function structuredEventAddress(
  locationObj: Record<string, unknown> | undefined,
  venueName: string | null
): string | null {
  const rawAddr = locationObj?.address
  return (
    (rawAddr && typeof rawAddr === "object" && !Array.isArray(rawAddr)
      ? [
          pickText((rawAddr as Record<string, unknown>).streetAddress),
          pickText((rawAddr as Record<string, unknown>).addressLocality),
          pickText((rawAddr as Record<string, unknown>).addressRegion),
          pickText((rawAddr as Record<string, unknown>).postalCode),
        ]
          .filter(Boolean)
          .join(", ") || null
      : (pickText(rawAddr) ?? pickText(locationObj?.["streetAddress"]))) ?? venueName
  )
}

function collectStructuredImageUrls(imageValue: unknown, sourceUrl: string): string[] {
  const webImages: string[] = []
  for (const image of extractImageUrls(imageValue)) {
    const normalized = normalizeUrl(image, sourceUrl)
    if (normalized && validateExternalUrl(normalized).ok && !webImages.includes(normalized)) {
      webImages.push(normalized)
    }
    if (webImages.length >= 5) {
      break
    }
  }
  return webImages
}

function mapStructuredEvent(
  candidate: Record<string, unknown>,
  sourceUrl: string
): StructuredEvent | null {
  const title = pickText(candidate.name)
  if (!title) {
    return null
  }

  const startDatetime = parseIsoDate(pickText(candidate.startDate))
  if (!startDatetime) {
    return null
  }

  const endDatetime = parseIsoDate(pickText(candidate.endDate))
  const description = cleanDescription(pickText(candidate.description)) || title
  const eventUrl = normalizeUrl(pickText(candidate.url), sourceUrl) ?? sourceUrl
  const locationObj = candidate.location as Record<string, unknown> | undefined
  const venueName = pickText(locationObj?.name) ?? pickText(candidate.location)
  const address = structuredEventAddress(locationObj, venueName)
  const webImages = collectStructuredImageUrls(candidate.image, sourceUrl)

  const offers = candidate.offers as Record<string, unknown> | undefined
  const priceFromOffers = offerPrice(offers?.price)
  const isFreeFromOffers = priceFromOffers === 0
  const priceInfo = extractPrice(description)

  return {
    title,
    description: description.slice(0, 500),
    startDatetime,
    endDatetime,
    venueName,
    address,
    sourceUrl: eventUrl,
    imageUrl: webImages[0] ?? null,
    images: webImages,
    price: priceFromOffers ?? priceInfo.price,
    isFree: isFreeFromOffers || priceInfo.isFree,
  }
}

function parseStructuredEvents(
  doc: ReturnType<DOMParser["parseFromString"]>,
  sourceUrl: string
): StructuredEvent[] {
  if (!doc) {
    return []
  }

  const events: StructuredEvent[] = []
  for (const candidate of collectJsonLdEventNodes(doc)) {
    const event = mapStructuredEvent(candidate, sourceUrl)
    if (event) {
      events.push(event)
    }
  }

  return events
}

function parseMecCalendarEvents(
  doc: ReturnType<DOMParser["parseFromString"]>,
  sourceUrl: string,
  timeZone: string,
  structuredEvents: StructuredEvent[]
): ParsedEvent[] {
  if (!doc) {
    return []
  }

  const structuredByUrl = new Map(
    structuredEvents
      .filter((event) => event.sourceUrl)
      .map((event) => [event.sourceUrl as string, event])
  )
  const seenKeys = new Set<string>()
  const events: ParsedEvent[] = []

  for (const dayNode of doc.querySelectorAll(".mec-calendar-day[data-mec-cell]")) {
    const dateStamp = dayNode.getAttribute("data-mec-cell") ?? ""
    for (const link of dayNode.querySelectorAll(
      "a.event-single-link-simple[data-tooltip-content]"
    )) {
      const title = pickText(link.querySelector(".mec-event-title")?.textContent)
      if (!title) {
        continue
      }

      const tooltipSelector = link.getAttribute("data-tooltip-content")
      const tooltip = tooltipSelector ? doc.querySelector(tooltipSelector) : null
      const parsedTime = parseMecTimeRange(
        dateStamp,
        tooltip?.querySelector(".mec-tooltip-event-time")?.textContent ?? "",
        timeZone
      )
      if (!parsedTime) {
        continue
      }

      const eventUrl = normalizeUrl(link.getAttribute("href"), sourceUrl) ?? sourceUrl
      const structured = structuredByUrl.get(eventUrl)
      const rawDescription = tooltip?.querySelector(".mec-tooltip-event-desc")?.textContent ?? ""
      const description =
        structured?.description ?? cleanDescription(rawDescription.replace(/\s*,\s*\.\.\.$/, ""))
      const tooltipImage = tooltip?.querySelector("img")?.getAttribute("src") ?? null
      const imageUrl = structured?.imageUrl ?? normalizeUrl(tooltipImage, sourceUrl)
      const images = structured?.images.length ? structured.images : imageUrl ? [imageUrl] : []
      const priceInfo = extractPrice(description)

      const key = `${eventUrl}::${parsedTime.startDatetime}`
      if (seenKeys.has(key)) {
        continue
      }

      seenKeys.add(key)
      events.push({
        title,
        description: description.slice(0, 500),
        startDatetime: parsedTime.startDatetime,
        endDatetime: parsedTime.endDatetime,
        venueName: structured?.venueName ?? null,
        address: structured?.address ?? structured?.venueName ?? null,
        sourceUrl: eventUrl,
        imageUrl,
        images,
        price: structured?.price ?? priceInfo.price,
        isFree: structured?.isFree ?? priceInfo.isFree,
      })
    }
  }

  return events
}

function parseBatonRougeZooCards(
  doc: ReturnType<DOMParser["parseFromString"]>,
  sourceUrl: string,
  timeZone: string
): ParsedEvent[] {
  if (!doc) {
    return []
  }

  const events: ParsedEvent[] = []
  const seenKeys = new Set<string>()
  for (const item of doc.querySelectorAll(".repeater-list-item")) {
    const element = item as Element
    const title = textFromFirst(element, [".repeater-list-card-img-lg-item-header", "h3"])
    const linkHref = attrFromFirst(element, ["a[href]"], ["href"])
    const eventUrl = normalizeUrl(linkHref, sourceUrl)
    const urlDate = eventUrl ? new URL(eventUrl).searchParams.get("occdate") : null
    const date =
      parseIsoDateStamp(urlDate) ??
      parseDateParts(
        textFromFirst(element, [".event-month"]),
        textFromFirst(element, [".event-day"]),
        new Date().getUTCFullYear().toString()
      )
    const timeText = textFromFirst(element, [".item-time"])
    if (!title || !date || !timeText) {
      continue
    }
    const parsedTime = parseTimeRangeForDate(date, timeText, timeZone)
    if (!parsedTime) {
      continue
    }

    const imageUrl = validImageUrl(
      attrFromFirst(element, ["img", "source"], ["data-src", "src", "data-image"]),
      sourceUrl
    )
    const description = cleanDescription([title, timeText].filter(Boolean).join(" — "))
    const priceInfo = extractPrice(description)
    const key = `${eventUrl ?? title}::${parsedTime.startDatetime}`
    if (seenKeys.has(key)) {
      continue
    }
    seenKeys.add(key)
    events.push({
      title,
      description: description.slice(0, 500),
      startDatetime: parsedTime.startDatetime,
      endDatetime: parsedTime.endDatetime,
      venueName: "BREC's Baton Rouge Zoo",
      address: "3601 Thomas Rd, Baton Rouge, LA 70807",
      sourceUrl: eventUrl,
      imageUrl,
      images: imageUrl ? [imageUrl] : [],
      price: priceInfo.price,
      isFree: priceInfo.isFree,
    })
  }

  return events
}

function firstYearFromDocument(doc: ReturnType<DOMParser["parseFromString"]>): number | null {
  if (!doc) {
    return null
  }
  // linkedom deviation: unlike deno-dom, fragment parses leave document.body empty and hang
  // content off documentElement, so fall back to documentElement text when body has none.
  const text = ("body" in doc ? doc.body?.textContent : null) || doc.documentElement?.textContent
  const match = text?.match(/\b(20\d{2})\b/)
  return match ? Number(match[1]) : null
}

function parseAllInOneCalendarEvents(
  doc: ReturnType<DOMParser["parseFromString"]>,
  sourceUrl: string,
  timeZone: string
): ParsedEvent[] {
  if (!doc) {
    return []
  }

  const fallbackYear = firstYearFromDocument(doc)
  const events: ParsedEvent[] = []
  const seenKeys = new Set<string>()
  for (const popover of doc.querySelectorAll(".ai1ec-popover")) {
    const element = popover as Element
    const title = textFromFirst(element, [".ai1ec-popup-title a", ".ai1ec-event-title"])
    const eventUrl = normalizeUrl(
      attrFromFirst(element, [".ai1ec-popup-title a[href]", "a[href]"], ["href"]),
      sourceUrl
    )
    const timeText = textFromFirst(element, [".ai1ec-event-time"])
    const parsedTime = timeText ? parseHumanDateTimeRange(timeText, fallbackYear, timeZone) : null
    if (!title || !parsedTime) {
      continue
    }

    const rawLocation = textFromFirst(element, [".ai1ec-event-location"])
    const venueName = rawLocation?.replace(/^@\s*/, "") || null
    const description = cleanDescription(
      textFromFirst(element, [".ai1ec-event-description"]) ?? title
    )
    const priceInfo = extractPrice(description)
    const key = `${eventUrl ?? title}::${parsedTime.startDatetime}`
    if (seenKeys.has(key)) {
      continue
    }
    seenKeys.add(key)
    events.push({
      title,
      description: description.slice(0, 500),
      startDatetime: parsedTime.startDatetime,
      endDatetime: parsedTime.endDatetime,
      venueName,
      address: venueName,
      sourceUrl: eventUrl,
      imageUrl: null,
      images: [],
      price: priceInfo.price,
      isFree: priceInfo.isFree,
    })
  }

  return events
}

function parseSquarespaceSummaryEvents(
  doc: ReturnType<DOMParser["parseFromString"]>,
  sourceUrl: string,
  timeZone: string
): ParsedEvent[] {
  if (!doc) {
    return []
  }

  const events: ParsedEvent[] = []
  const seenKeys = new Set<string>()
  for (const item of doc.querySelectorAll(".summary-item-record-type-event")) {
    const element = item as Element
    const title =
      textFromFirst(element, [".summary-title-link"]) ??
      attrFromFirst(element, ["a[data-title]"], ["data-title"])
    const rawDate = textFromFirst(element, [".summary-metadata-item--date", "time"])
    const date = rawDate ? parseDateFromTextParts(rawDate) : null
    if (!title || !date) {
      continue
    }

    const startDatetime = wallClockToIso({ ...date, hour: 0, minute: 0 }, timeZone)
    const eventUrl = normalizeUrl(
      attrFromFirst(element, [".summary-title-link[href]", "a[href]"], ["href"]),
      sourceUrl
    )
    const imageUrl = validImageUrl(
      attrFromFirst(element, ["img"], ["data-src", "src", "data-image"]),
      sourceUrl
    )
    const description = cleanDescription(textFromFirst(element, [".summary-excerpt"]) ?? title)
    const priceInfo = extractPrice(description)
    const key = `${eventUrl ?? title}::${startDatetime}`
    if (seenKeys.has(key)) {
      continue
    }
    seenKeys.add(key)
    events.push({
      title,
      description: description.slice(0, 500),
      startDatetime,
      endDatetime: null,
      venueName: null,
      address: null,
      sourceUrl: eventUrl,
      imageUrl,
      images: imageUrl ? [imageUrl] : [],
      price: priceInfo.price,
      isFree: priceInfo.isFree,
    })
  }

  return events
}

/**
 * Parses a website HTML document for events.
 * Tries site-specific extractors (MEC, Baton Rouge Zoo cards, All-in-One Calendar,
 * Squarespace) before falling back to generic structured data.
 */
export function parseWebsite(html: string, sourceUrl: string, timeZone = "UTC"): ParsedEvent[] {
  const parser = new DOMParser()
  const doc = parser.parseFromString(html, "text/html")
  if (!doc) {
    return []
  }

  const structuredEvents = parseStructuredEvents(doc, sourceUrl)
  const mecEvents = parseMecCalendarEvents(doc, sourceUrl, timeZone, structuredEvents)
  if (mecEvents.length > 0) {
    return mecEvents
  }

  const batonRougeZooEvents = parseBatonRougeZooCards(doc, sourceUrl, timeZone)
  if (batonRougeZooEvents.length > 0) {
    return batonRougeZooEvents
  }

  const allInOneCalendarEvents = parseAllInOneCalendarEvents(doc, sourceUrl, timeZone)
  if (allInOneCalendarEvents.length > 0) {
    return allInOneCalendarEvents
  }

  const squarespaceSummaryEvents = parseSquarespaceSummaryEvents(doc, sourceUrl, timeZone)
  if (squarespaceSummaryEvents.length > 0) {
    return squarespaceSummaryEvents
  }

  const seenKeys = new Set<string>()
  const events: ParsedEvent[] = []
  for (const structured of structuredEvents) {
    const key = `${structured.title.toLowerCase()}::${structured.startDatetime}`
    if (seenKeys.has(key)) {
      continue
    }
    seenKeys.add(key)
    events.push(structured)
  }

  return events
}

/** Generic website parser supporting multiple event calendar formats and site-specific cards. */
export const websiteParser: SourceParser<"website"> = {
  type: "website",
  async fetchArtifact(source, ctx) {
    const html = await ctx.fetchText(source.url, {
      accept: "text/html,application/xml,text/xml,*/*",
    })
    return { url: source.url, contentType: "text/html", body: html }
  },
  extractEvents(source, artifact, ctx) {
    return Promise.resolve(parseWebsite(artifact.body, artifact.url || source.url, ctx.timezone))
  },
}
