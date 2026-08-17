// Stock image search client — looks up a landscape photo by event title or tag
// for events that landed with empty `events.images`.
// Ported from family-events-backend supabase/functions/_shared/stock-images.ts (U29).
// Deviations:
// - none beyond the env seam — the module takes provider API keys as a
//   `StockImageProviderKeys` parameter (no Deno.env.get calls existed in the
//   legacy source), so callers resolve PEXELS_API_KEY / PIXABAY_API_KEY /
//   UNSPLASH_ACCESS_KEY themselves before invoking these functions.
// - Verified against legacy: this module does NOT import ./unsplash.ts. It
//   duplicates its own deriveTitleSearchTerm (noise-word filtering + library
//   context preservation — different from unsplash.ts's simpler version),
//   Unsplash response types, and trackUnsplashDownload, matching upstream's
//   actual (non-shared) structure exactly.
//
// Provider fallback chain:
//   1. Pexels (200/hour → unlimited after approval) — primary
//   2. Pixabay (6,000/hour, requires 24hr caching) — backup
//   3. Unsplash (50/hour, kept for compatibility) — last resort
//
// Each provider tries title-derived term first, then tag slugs.
//
// Query strategy — most-specific first:
//   1. Title-derived term: normalize the event title into a 2-4 word phrase
//      (strip venue suffixes, punctuation) and search that.
//   2. Tag slug fallback: walk tags in confidence DESC order and try each.
//
// Rate limits (as of 2026-05-27):
//   - Pexels: 200/hour default, unlimited available for free via email
//   - Pixabay: 100/min (6,000/hour), no monthly cap
//   - Unsplash: 50/hour demo tier, 5,000/hour production (paid)
//
// Attribution requirements:
//   - Pexels: show photographer + "Photos provided by Pexels" link
//   - Pixabay: show attribution when displaying search results (API terms)
//   - Unsplash: track downloads + photographer attribution required

export type StockProvider = "pexels" | "pixabay" | "unsplash"

export interface StockImageAttribution {
  photoId: string
  photographerName: string
  photographerUsername?: string
  photographerProfileUrl: string
  photoUrl: string
  downloadLocation?: string // Only Unsplash requires download tracking
  provider: StockProvider
}

export interface StockImageResult {
  url: string
  /** Search term we matched on (for logging). May be a title-derived term or a tag slug. */
  matchedTag: string
  attribution: StockImageAttribution
}

export interface StockImageTrackingResult {
  ok: boolean
  error: string | null
}

const PEXELS_SEARCH_ENDPOINT = "https://api.pexels.com/v1/search"
const PIXABAY_SEARCH_ENDPOINT = "https://pixabay.com/api/"
const UNSPLASH_SEARCH_ENDPOINT = "https://api.unsplash.com/search/photos"

// Pexels response types
interface PexelsPhoto {
  id: number
  url: string
  photographer: string
  photographer_url: string
  src: {
    large: string
    large2x: string
    medium: string
    original: string
  }
}

interface PexelsSearchResponse {
  page?: number
  per_page?: number
  photos?: PexelsPhoto[]
  total_results?: number
}

// Pixabay response types
interface PixabayHit {
  id: number
  pageURL: string
  largeImageURL: string
  fullHDURL?: string
  imageURL?: string
  user: string
  user_id: number
}

interface PixabaySearchResponse {
  total?: number
  totalHits?: number
  hits?: PixabayHit[]
}

// Unsplash response types (kept for compatibility)
interface UnsplashSearchHit {
  id?: string
  urls?: {
    regular?: string
  }
  links?: {
    html?: string
    download_location?: string
  }
  user?: {
    name?: string
    username?: string
    links?: {
      html?: string
    }
  }
}

interface UnsplashSearchResponse {
  results?: UnsplashSearchHit[]
}

function firstString(...values: Array<string | undefined | null>): string | null {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed) return trimmed
  }
  return null
}

/**
 * Words that dilute stock-photo search specificity without adding visual
 * meaning. Filtered out before the 4-word cap so the query slots are
 * occupied by content-bearing terms instead.
 */
const NOISE_WORDS = new Set([
  "free",
  "annual",
  "weekly",
  "monthly",
  "daily",
  "special",
  "new",
  "the",
  "a",
  "an",
  "and",
  "or",
  "for",
  "with",
  "in",
])

/**
 * Derive a 2-4 word search term from an event title.
 *
 * Strips common venue suffix patterns ("at West Regional Library",
 * "presented by BREC", "hosted by …"), punctuation, and noise words
 * (articles, frequency markers like "weekly", filler prepositions),
 * then takes the first four remaining words. Returns null when the
 * result is too short to be useful.
 *
 * Examples:
 *   "Splash Park at East Side Recreation Center" → "splash park"
 *   "Free FIFA World Cup Watch Party" → "fifa world cup watch"
 *   "Community Day" → "community day" (short but still useful)
 */
export function deriveTitleSearchTerm(title: string): string | null {
  // Preserve venue keywords that provide essential activity context
  const hasLibrary = /\blibrary\b/i.test(title)

  const normalized = title
    // For library events, DON'T strip "at Library" — it's essential context.
    // For other events, strip all venue suffixes as before.
    .replace(
      hasLibrary
        ? /\s+(?:presented by|hosted by|sponsored by)\b.*/i
        : /\s+(?:at|presented by|hosted by|sponsored by)\b.*/i,
      ""
    )
    // Strip remaining punctuation (keep spaces and word chars)
    .replace(/[^\w\s]/g, " ")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !NOISE_WORDS.has(w))
    .slice(0, 4)
    .join(" ")

  // Require at least 4 characters (filters out single-char noise after stripping)
  return normalized.length >= 4 ? normalized : null
}

async function searchPexels(
  query: string,
  apiKey: string,
  options: { fetchImpl?: typeof fetch } = {}
): Promise<StockImageResult | null> {
  const fetcher = options.fetchImpl ?? fetch
  const url = `${PEXELS_SEARCH_ENDPOINT}?query=${encodeURIComponent(query)}&orientation=landscape&per_page=15`

  try {
    const res = await fetcher(url, {
      headers: {
        Authorization: apiKey,
      },
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return null

    const body = (await res.json()) as PexelsSearchResponse
    const photos = body.photos ?? []
    if (photos.length === 0) return null

    // Pick randomly among results to avoid always getting the same photo
    const photo = photos[Math.floor(Math.random() * photos.length)]
    if (!photo) return null

    return {
      url: photo.src.large,
      matchedTag: query,
      attribution: {
        photoId: String(photo.id),
        photographerName: photo.photographer,
        photographerProfileUrl: photo.photographer_url,
        photoUrl: photo.url,
        provider: "pexels",
      },
    }
  } catch {
    return null
  }
}

async function searchPixabay(
  query: string,
  apiKey: string,
  options: { fetchImpl?: typeof fetch } = {}
): Promise<StockImageResult | null> {
  const fetcher = options.fetchImpl ?? fetch
  const url = `${PIXABAY_SEARCH_ENDPOINT}?key=${apiKey}&q=${encodeURIComponent(query)}&orientation=horizontal&per_page=20&safesearch=true`

  try {
    const res = await fetcher(url, {
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return null

    const body = (await res.json()) as PixabaySearchResponse
    const hits = body.hits ?? []
    if (hits.length === 0) return null

    // Pick randomly among results
    const hit = hits[Math.floor(Math.random() * hits.length)]
    if (!hit) return null

    return {
      url: hit.largeImageURL,
      matchedTag: query,
      attribution: {
        photoId: String(hit.id),
        photographerName: hit.user,
        photographerUsername: String(hit.user_id),
        photographerProfileUrl: hit.pageURL,
        photoUrl: hit.pageURL,
        provider: "pixabay",
      },
    }
  } catch {
    return null
  }
}

async function searchUnsplash(
  query: string,
  accessKey: string,
  options: { fetchImpl?: typeof fetch } = {}
): Promise<StockImageResult | null> {
  const fetcher = options.fetchImpl ?? fetch
  const url = `${UNSPLASH_SEARCH_ENDPOINT}?query=${encodeURIComponent(query)}&orientation=landscape&per_page=5&content_filter=high`

  try {
    const res = await fetcher(url, {
      headers: {
        Authorization: `Client-ID ${accessKey}`,
        "Accept-Version": "v1",
      },
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return null

    const body = (await res.json()) as UnsplashSearchResponse
    const results = body.results ?? []
    if (results.length === 0) return null

    const hit = results[Math.floor(Math.random() * results.length)]
    const photoUrl = hit?.urls?.regular
    if (!hit || !photoUrl) return null

    const photoId = firstString(hit.id)
    const photographerUsername = firstString(hit.user?.username)
    const photographerName = firstString(hit.user?.name, photographerUsername)
    const photographerProfileUrl = firstString(hit.user?.links?.html)
    const photoPageUrl = firstString(hit.links?.html)
    const downloadLocation = firstString(hit.links?.download_location)

    if (
      !photoId ||
      !photographerName ||
      !photographerUsername ||
      !photographerProfileUrl ||
      !photoPageUrl ||
      !downloadLocation
    ) {
      return null
    }

    return {
      url: photoUrl,
      matchedTag: query,
      attribution: {
        photoId,
        photographerName,
        photographerUsername,
        photographerProfileUrl,
        photoUrl: photoPageUrl,
        downloadLocation,
        provider: "unsplash",
      },
    }
  } catch {
    return null
  }
}

export interface StockImageProviderKeys {
  pexels?: string
  pixabay?: string
  unsplash?: string
}

/**
 * Resolve a single stock image URL for an event with provider fallback chain.
 *
 * Provider order:
 *   1. Pexels (200/hour → unlimited after approval)
 *   2. Pixabay (6,000/hour)
 *   3. Unsplash (50/hour, kept for compatibility)
 *
 * Search order (per provider, most-specific first):
 *   1. Title-derived term — strips venue suffix, normalizes to 2-4 words.
 *      E.g. "Splash Park at East Side Recreation Center" → "splash park".
 *      Produces the most relevant photos for niche activity events.
 *   2. Tag slugs — walks tags in caller-supplied order (confidence DESC) and
 *      tries each. Used as fallback when the title yields no results.
 *
 * For each search term we request multiple results and pick one randomly.
 * This prevents all events sharing the same primary term from permanently
 * receiving the identical photo.
 *
 * Returns `null` when no providers are configured, when every candidate misses,
 * or on any network / parse error.
 */
export async function findFallbackImage(
  tags: string[],
  providerKeys: StockImageProviderKeys,
  options: { fetchImpl?: typeof fetch; title?: string } = {}
): Promise<StockImageResult | null> {
  // Build the ordered search queue: title-derived term first, tag slugs after.
  const queue: Array<{ searchTerm: string }> = []

  if (options.title) {
    const term = deriveTitleSearchTerm(options.title)
    if (term) queue.push({ searchTerm: term })
  }

  for (const rawTag of tags) {
    const tag = rawTag.trim()
    if (tag) queue.push({ searchTerm: tag })
  }

  if (queue.length === 0) return null

  // Provider fallback chain
  const providers: Array<{
    name: StockProvider
    key: string
    search: (query: string, key: string, opts: typeof options) => Promise<StockImageResult | null>
  }> = []

  if (providerKeys.pexels) {
    providers.push({ name: "pexels", key: providerKeys.pexels, search: searchPexels })
  }
  if (providerKeys.pixabay) {
    providers.push({ name: "pixabay", key: providerKeys.pixabay, search: searchPixabay })
  }
  if (providerKeys.unsplash) {
    providers.push({ name: "unsplash", key: providerKeys.unsplash, search: searchUnsplash })
  }

  if (providers.length === 0) return null

  // Try each provider in order
  for (const provider of providers) {
    for (const { searchTerm } of queue) {
      // Two-pass strategy for each term:
      // 1. Try bare term first (more specific for activity searches)
      // 2. Fall back to "{term} family" only when bare returns empty
      const attempts = [searchTerm, `${searchTerm} family`]

      for (const query of attempts) {
        const result = await provider.search(query, provider.key, options)
        if (result) {
          return result
        }
      }
    }
  }

  return null
}

/**
 * Track Unsplash download (required by Unsplash API terms).
 * Only needed when using Unsplash provider.
 */
export async function trackUnsplashDownload(
  downloadLocation: string,
  accessKey: string,
  options: { fetchImpl?: typeof fetch } = {}
): Promise<StockImageTrackingResult> {
  if (!accessKey) return { ok: false, error: "UNSPLASH_ACCESS_KEY is not configured" }
  if (!downloadLocation.trim()) return { ok: false, error: "download location is empty" }

  const fetcher = options.fetchImpl ?? fetch

  try {
    const res = await fetcher(downloadLocation, {
      headers: {
        Authorization: `Client-ID ${accessKey}`,
        "Accept-Version": "v1",
      },
      signal: AbortSignal.timeout(3_000),
    })
    if (!res.ok) return { ok: false, error: `Unsplash tracking failed with HTTP ${res.status}` }
    return { ok: true, error: null }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
