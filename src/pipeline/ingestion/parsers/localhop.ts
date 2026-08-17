// Ported verbatim from family-events-backend supabase/functions/scrape-source/parsers/localhop.ts (U28).

import { cleanDescription, extractPrice, parseIsoDate } from "../parsing.js"
import { guardedFetch, SsrfRejectedError } from "../guarded-fetch.js"
import { validateExternalUrl } from "../url-validation.js"
import type { ParsedEvent } from "../types.js"
import type { SourceParser } from "./_lib/types.js"

const LOCALHOP_APP_ID = "zesqKJEzK7ncFXe57x4uWc4Moow3I2wGCq7zFcqI"
const LOCALHOP_API_URL = "https://api.getlocalhop.com/1/classes/EventInstance"

type LocalHopPointerDate = {
  iso?: unknown
}

type LocalHopAddress = {
  place?: unknown
  address1?: unknown
  address2?: unknown
  city?: unknown
  state?: unknown
  postalCode?: unknown
  room?: unknown
}

type LocalHopApiRow = {
  objectId?: unknown
  slug?: unknown
  standardStartDate?: LocalHopPointerDate
  standardEndDate?: LocalHopPointerDate
  actualStartDate?: LocalHopPointerDate
  actualEndDate?: LocalHopPointerDate
  event?: {
    name?: unknown
    description?: unknown
    slug?: unknown
    address?: LocalHopAddress
    photo?: {
      url?: unknown
    }
  }
}

type LocalHopApiResponse = {
  results?: unknown
}

function pickString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function parseDate(value: LocalHopPointerDate | undefined): string | null {
  return parseIsoDate(pickString(value?.iso))
}

function addressLine(address: LocalHopAddress | undefined): string | null {
  if (!address) {
    return null
  }
  return (
    [
      pickString(address.address1),
      pickString(address.address2),
      pickString(address.city),
      pickString(address.state),
      pickString(address.postalCode),
    ]
      .filter(Boolean)
      .join(", ") || null
  )
}

function localHopEventUrl(row: LocalHopApiRow): string | null {
  const slug = pickString(row.slug) ?? pickString(row.event?.slug)
  const objectId = pickString(row.objectId)
  if (!slug || !objectId) {
    return null
  }
  return `https://events.getlocalhop.com/${slug}/event/${objectId}/`
}

function localHopImageUrl(row: LocalHopApiRow): string | null {
  const url = pickString(row.event?.photo?.url)
  return url && validateExternalUrl(url).ok ? url : null
}

/**
 * Parses LocalHop EventInstance API response into normalized ParsedEvent list.
 * Deduplicates by sourceUrl+start, extracts price from description, validates images.
 */
export function parseLocalHopEvents(value: unknown): ParsedEvent[] {
  if (typeof value !== "object" || value === null) {
    return []
  }
  const response = value as LocalHopApiResponse
  if (!Array.isArray(response.results)) {
    return []
  }

  const events: ParsedEvent[] = []
  const seenKeys = new Set<string>()
  for (const rawRow of response.results) {
    if (!rawRow || typeof rawRow !== "object") {
      continue
    }
    const row = rawRow as LocalHopApiRow
    const title = pickString(row.event?.name)
    const startDatetime = parseDate(row.standardStartDate) ?? parseDate(row.actualStartDate)
    if (!title || !startDatetime) {
      continue
    }

    const endDatetime = parseDate(row.standardEndDate) ?? parseDate(row.actualEndDate)
    const description = cleanDescription(pickString(row.event?.description) ?? title)
    const priceInfo = extractPrice(description)
    const venueName = pickString(row.event?.address?.place)
    const address = addressLine(row.event?.address) ?? venueName
    const sourceUrl = localHopEventUrl(row)
    const imageUrl = localHopImageUrl(row)
    const key = `${sourceUrl ?? title}::${startDatetime}`
    if (seenKeys.has(key)) {
      continue
    }
    seenKeys.add(key)

    events.push({
      title,
      description: description.slice(0, 500),
      startDatetime,
      endDatetime,
      venueName,
      address,
      sourceUrl,
      imageUrl,
      images: imageUrl ? [imageUrl] : [],
      price: priceInfo.price,
      isFree: priceInfo.isFree,
    })
  }

  return events
}

function buildLocalHopUrl(sourceUrl: string): string {
  const source = new URL(sourceUrl)
  const limit = source.searchParams.get("limit") ?? "100"
  const rawDays = source.searchParams.get("days")
  const parsedDays = rawDays != null ? Number(rawDays) : 120
  const days = Number.isFinite(parsedDays) && parsedDays >= 0 ? parsedDays : 120
  const startsAt = new Date()
  const endsAt = new Date(startsAt.getTime() + days * 24 * 60 * 60 * 1000)
  const where: Record<string, unknown> = {
    status: "publish",
    standardStartDate: {
      $gte: { __type: "Date", iso: startsAt.toISOString() },
      $lte: { __type: "Date", iso: endsAt.toISOString() },
    },
  }

  const organizationObjectId = source.searchParams.get("organizationObjectId")
  if (organizationObjectId) {
    where.organization = {
      __type: "Pointer",
      className: "Organization",
      objectId: organizationObjectId,
    }
  }
  const city = source.searchParams.get("city")
  if (city) {
    where.city = city.toLowerCase()
  }
  const state = source.searchParams.get("state")
  if (state) {
    where.state = state.toLowerCase()
  }

  const apiUrl = new URL(LOCALHOP_API_URL)
  apiUrl.searchParams.set("limit", limit)
  apiUrl.searchParams.set("order", "standardStartDate")
  apiUrl.searchParams.set("include", "event,organization,event.organization,event.categories")
  apiUrl.searchParams.set("where", JSON.stringify(where))
  return apiUrl.toString()
}

const FETCH_TIMEOUT_MS = 10_000

/** LocalHop source parser: fetches via Parse-backed EventInstance API with org/city filters. */
export const localHopParser: SourceParser<"localhop"> = {
  type: "localhop",
  async fetchArtifact(source) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

    let response: Response
    try {
      response = await guardedFetch(buildLocalHopUrl(source.url), {
        headers: {
          Accept: "application/json",
          "X-Parse-Application-Id": LOCALHOP_APP_ID,
        },
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timeoutId)
      if (err instanceof SsrfRejectedError) {
        throw new Error(`localhop: blocked by SSRF guard: ${err.message}`)
      }
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`localhop: fetch timed out after ${FETCH_TIMEOUT_MS}ms`)
      }
      throw err
    }

    clearTimeout(timeoutId)

    if (!response.ok) {
      throw new Error(`localhop: fetch failed with HTTP ${response.status}`)
    }
    return {
      url: source.url,
      contentType: "application/json",
      body: await response.text(),
    }
  },
  extractEvents(_source, artifact) {
    return Promise.resolve(parseLocalHopEvents(JSON.parse(artifact.body)))
  },
}
