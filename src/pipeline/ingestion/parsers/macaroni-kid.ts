// Ported verbatim from family-events-backend supabase/functions/scrape-source/parsers/macaroni-kid.ts (U28).

import { cleanDescription, extractPrice, parseIsoDate, stripHtml } from "../parsing.js"
import { validateExternalUrl } from "../url-validation.js"
import type { EventSourceRow, ParsedEvent } from "../types.js"
import type { SourceParser } from "./_lib/types.js"

const DEFAULT_WINDOW_DAYS = 90
const API_LIMIT = 802
const MS_PER_DAY = 86_400_000

type Json = Record<string, unknown>

function asJson(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null
}

function asString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value)
  }
  return null
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function extractTownId(html: string): string | null {
  const match = html.match(/data-town\s*=\s*"([^"]+)"/i) ?? html.match(/data-town\s*=\s*'([^']+)'/i)
  return match?.[1]?.trim() || null
}

function buildApiUrl(townId: string, windowDays: number, now: Date = new Date()): string {
  const start = now
  const end = new Date(start.getTime() + windowDays * MS_PER_DAY)
  const query = JSON.stringify({
    status: "active",
    townOwner: townId,
    startDate: start.toISOString(),
    endDate: end.toISOString(),
  })
  return (
    `https://api.macaronikid.com/api/v1/event/v2` +
    `?query=${encodeURIComponent(query)}` +
    `&impression=true&limit=${API_LIMIT}`
  )
}

function buildSourceUrl(sourceBase: string, id: string | null, slug: string | null): string | null {
  if (!id) return null
  const base = sourceBase.replace(/\/events\/?$/, "")
  const tail = slug ? `${id}/${slug}` : id
  try {
    return new URL(`/events/${tail}`, base).toString()
  } catch {
    return null
  }
}

function joinAddress(location: Json | null): { venue: string | null; address: string | null } {
  if (!location) return { venue: null, address: null }
  const venue = asString(location.name) ?? asString(location.venue) ?? asString(location.title)
  const parts = [
    asString(location.address) ?? asString(location.address1) ?? asString(location.street),
    asString(location.address2),
    asString(location.city),
    asString(location.state) ?? asString(location.region),
    asString(location.zip) ?? asString(location.postalCode),
  ].filter((part): part is string => Boolean(part))
  const address = parts.length > 0 ? parts.join(", ") : null
  return { venue, address }
}

function pickImage(raw: unknown): string[] {
  const out: string[] = []
  const push = (candidate: unknown) => {
    const url = asString(candidate)
    if (url && validateExternalUrl(url).ok && !out.includes(url)) {
      out.push(url)
    }
  }
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === "string") {
        push(entry)
      } else if (entry && typeof entry === "object") {
        const obj = entry as Json
        push(obj.url ?? obj.src ?? obj.href)
      }
    }
  } else if (raw && typeof raw === "object") {
    const obj = raw as Json
    push(obj.url ?? obj.src ?? obj.href)
  } else {
    push(raw)
  }
  return out.slice(0, 5)
}

export function mapMacaroniKidEvent(raw: unknown, sourceBase: string): ParsedEvent | null {
  const node = asJson(raw)
  if (!node) return null

  const title = asString(node.name) ?? asString(node.title)
  if (!title) return null

  const startDatetime = parseIsoDate(
    asString(node.startDateTime) ?? asString(node.start) ?? asString(node.startDate)
  )
  if (!startDatetime) return null
  const endDatetime = parseIsoDate(
    asString(node.endDateTime) ?? asString(node.end) ?? asString(node.endDate)
  )

  const id = asString(node._id) ?? asString(node.id)
  const slug = asString(node.slug)
  const sourceUrl = buildSourceUrl(sourceBase, id, slug)

  // Macaroni Kid API v1 returns address data in two possible shapes:
  //   (a) node.address: { street1, city, state, zipCode } — top-level (current API)
  //   (b) node.location: { name, address, city, ... }     — legacy embedded object
  // Venue name comes from node.where (plain string) or node.location.name.
  const topLevelAddress = asJson(node.address)
  const locationObj = asJson(node.location)
  const { venue: locationVenue, address: locationAddress } = joinAddress(locationObj)
  // Prefer structured location.name (e.g. "Moncus Park") over the free-text
  // node.where field (which is often a general description like "Playground").
  // Fall back to node.where only when location has no name.
  const venue = locationVenue ?? asString(node.where)
  const address = (() => {
    if (topLevelAddress) {
      const parts = [
        asString(topLevelAddress.street1),
        asString(topLevelAddress.street2) || null,
        asString(topLevelAddress.city),
        asString(topLevelAddress.state),
        asString(topLevelAddress.zipCode) ?? asString(topLevelAddress.zip),
      ].filter((p): p is string => Boolean(p))
      return parts.length > 0 ? parts.join(", ") : null
    }
    return locationAddress
  })()

  const descriptionParts = [
    asString(node.who),
    asString(node.where),
    asString(node.how),
    asString(node.description),
  ]
    .filter((part): part is string => Boolean(part))
    .map((part) => stripHtml(part))
  const description = cleanDescription(descriptionParts.join("\n\n"))

  const images = pickImage(node.images ?? node.image ?? node.photo ?? node.thumbnail)

  const costText = asString(node.cost) ?? asString(node.price) ?? ""
  const numericCost = asNumber(node.cost) ?? asNumber(node.price)
  const priceFromText = extractPrice(costText)
  const price = numericCost ?? priceFromText.price
  const isFree = price === 0 || priceFromText.isFree

  return {
    title,
    description: description.slice(0, 500),
    startDatetime,
    endDatetime,
    venueName: venue,
    address: address ?? venue,
    sourceUrl,
    imageUrl: images[0] ?? null,
    images,
    price,
    isFree,
  }
}

export async function fetchMacaroniKidEvents(
  source: EventSourceRow,
  fetchText: (url: string) => Promise<string>,
  fetchJson: <T = unknown>(url: string) => Promise<T>,
  now: Date = new Date()
): Promise<ParsedEvent[]> {
  const html = await fetchText(source.url)
  const townId = extractTownId(html)
  if (!townId) {
    throw new Error("macaronikid: data-town attribute not found on page")
  }

  const windowDays = source.date_window_days ?? DEFAULT_WINDOW_DAYS
  const apiUrl = buildApiUrl(townId, windowDays, now)
  const payload = await fetchJson<unknown>(apiUrl)
  const rawEvents = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as Json | null)?.events)
      ? ((payload as Json).events as unknown[])
      : Array.isArray((payload as Json | null)?.data)
        ? ((payload as Json).data as unknown[])
        : []

  const events: ParsedEvent[] = []
  for (const raw of rawEvents) {
    const mapped = mapMacaroniKidEvent(raw, source.url)
    if (mapped) events.push(mapped)
  }
  return events
}

export const macaroniKidParser: SourceParser<"macaronikid"> = {
  type: "macaronikid",
  async fetchArtifact(source, ctx) {
    const html = await ctx.fetchText(source.url)
    return { url: source.url, contentType: "text/html", body: html }
  },
  async extractEvents(source, artifact, ctx) {
    const townId = extractTownId(artifact.body)
    if (!townId) {
      throw new Error("macaronikid: data-town attribute not found on page")
    }

    const windowDays = source.date_window_days ?? DEFAULT_WINDOW_DAYS
    const apiUrl = buildApiUrl(townId, windowDays)
    const payload = await ctx.fetchJson<unknown>(apiUrl)
    const rawEvents = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as Json | null)?.events)
        ? ((payload as Json).events as unknown[])
        : Array.isArray((payload as Json | null)?.data)
          ? ((payload as Json).data as unknown[])
          : []

    const events: ParsedEvent[] = []
    for (const raw of rawEvents) {
      const mapped = mapMacaroniKidEvent(raw, source.url)
      if (mapped) events.push(mapped)
    }
    return events
  },
}
