// Nominatim geocoder — free, no API key, 1 req/sec rate limit per their policy.
// https://operations.osmfoundation.org/policies/nominatim/
//
// Usage: always pass a descriptive User-Agent (contact info ideal for production).
// For local/private dev a generic identifier is fine.
//
// Ported from family-events-backend supabase/functions/_shared/geocode.ts (U29).
// Deviations: none beyond the env seam — this module has no env reads at all
// (fetch, AbortSignal.timeout, and setTimeout are all native in Node here).
// The module-level rate-limit queue below is per-process rather than
// per-V8-isolate in this NestJS deployment (a long-lived process instead of
// Supabase's per-invocation Deno isolates), so it enforces the 1 req/sec cap
// more consistently than the legacy per-isolate limiter did. The 429/error
// degrade-to-null behavior is preserved unchanged.

export interface GeocodeResult {
  latitude: number
  longitude: number
  source: "nominatim" | "city-fallback"
}

interface NominatimHit {
  lat: string
  lon: string
}

const NOMINATIM_UA = "family-events-ui/1.0 (geocoder)"
const NOMINATIM_RATE_LIMIT_MS = 1_000

// Rate-limiting note (advisor plan 011): the limiter below is per V8 isolate, so it
// enforces 1 req/sec only WITHIN a single function instance. When more than one
// instance geocodes concurrently (the enrichment cron overlapping tag-event),
// aggregate traffic can briefly exceed Nominatim's 1 req/sec policy. We accept that
// and DEGRADE GRACEFULLY rather than add cross-instance coordination:
// geocodeViaNominatim returns null on any non-2xx (incl. HTTP 429) and every caller
// falls back to the city centroid — so a throttle never crashes enrichment and an
// over-limit request is never hot-retried. Overlap is occasional today (cron is
// */15, sequential). If Nominatim ever hard-throttles/bans (sustained 429s),
// escalate to a Postgres-coordinated slot reservation (plan 011, option 1).

let lastNominatimRequestAt = 0
let nominatimQueue: Promise<void> = Promise.resolve()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForNominatimSlot(): Promise<void> {
  let releaseQueue: (() => void) | undefined
  const queueTail = new Promise<void>((resolve) => {
    releaseQueue = resolve
  })
  const previousQueue = nominatimQueue
  nominatimQueue = queueTail

  await previousQueue
  try {
    const elapsed = Date.now() - lastNominatimRequestAt
    if (elapsed < NOMINATIM_RATE_LIMIT_MS) {
      await sleep(NOMINATIM_RATE_LIMIT_MS - elapsed)
    }
    lastNominatimRequestAt = Date.now()
  } finally {
    releaseQueue?.()
  }
}

/**
 * Query Nominatim for a place. Returns lat/lng or null if not found / error.
 * Caller must respect the 1 req/sec rate limit.
 */
export async function geocodeViaNominatim(query: string): Promise<GeocodeResult | null> {
  if (!query || query.trim().length < 3) return null

  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`

  try {
    await waitForNominatimSlot()
    const res = await fetch(url, {
      headers: {
        "User-Agent": NOMINATIM_UA,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(5_000),
    })
    // Non-2xx (incl. 429 rate-limited): degrade to the caller's city-centroid
    // fallback. Do NOT retry — a hot retry would only worsen an over-limit burst.
    if (!res.ok) return null

    const hits = (await res.json()) as NominatimHit[]
    const first = hits?.[0]
    if (!first) return null

    const lat = Number(first.lat)
    const lng = Number(first.lon)
    if (Number.isNaN(lat) || Number.isNaN(lng)) return null

    return { latitude: lat, longitude: lng, source: "nominatim" }
  } catch {
    return null
  }
}

/**
 * Build a geocoding query string from event metadata. Prefers address, then venue
 * name, scoped by city to avoid matching a same-named place elsewhere.
 *
 * If the base string already mentions the city or state (e.g. scraper wrote
 * "444 Cajundome Blvd, Lafayette, LA, ..." into the address field), we don't
 * append the locality again — duplicate "Lafayette, LA, Lafayette, LA" tails
 * cause Nominatim to return zero hits for what would otherwise be a precise
 * match.
 *
 * Also returns the base string unchanged if the address already contains a
 * two-letter state abbreviation pattern (e.g. ', LA' or ', TX,'), even when
 * city_id refers to a different city — this prevents contradictory locality
 * suffixes like '701 St. Nazaire, Broussard, LA, 70518, Lafayette, LA'.
 */
export function buildGeocodeQuery(parts: {
  address: string | null
  venueName: string | null
  cityName: string | null
  cityState: string | null
}): string | null {
  const base = parts.address?.trim() || parts.venueName?.trim()
  if (!base) return null

  const baseLower = base.toLowerCase()
  const cityMentioned = parts.cityName != null && baseLower.includes(parts.cityName.toLowerCase())
  // Use word-boundary matching so a 2-letter state abbreviation (e.g. "LA")
  // is not falsely detected as a substring of a city name (e.g. "Lafayette").
  const stateMentioned =
    parts.cityState != null &&
    new RegExp(`(?<![a-zA-Z])${parts.cityState}(?![a-zA-Z])`, "i").test(base)

  // Also skip when address already contains a state abbreviation (e.g. ", LA" or ", TX, ")
  // even if city_id points to a different city — prevents contradictory locality queries.
  const hasInlineState = /,\s*[A-Z]{2}(\s|,|$)/.test(base)

  if ((cityMentioned && stateMentioned) || hasInlineState) {
    return base
  }

  const localityParts: string[] = []
  if (parts.cityName && !cityMentioned) localityParts.push(parts.cityName)
  if (parts.cityState && !stateMentioned) localityParts.push(parts.cityState)
  const locality = localityParts.join(", ")
  return locality ? `${base}, ${locality}` : base
}
