// Unsplash search client — looks up a landscape photo by event title or tag
// slug for events that landed with empty `events.images`.
// Ported from family-events-backend supabase/functions/_shared/unsplash.ts (U29).
// Deviations: none beyond the env seam — the module takes accessKey as a
// parameter (no Deno.env.get calls existed in the legacy source), so callers
// resolve UNSPLASH_ACCESS_KEY themselves before invoking these functions.
//
// Why this exists: scraper sources frequently strip image URLs (hot-link
// blocking, robots policies, login-walled CDN). Without a fallback, every
// affected card on web / iOS / Android renders a generic picsum.photos
// placeholder that doesn't match the event. Unsplash returns a real photo
// keyed to the event subject, which keeps the "warm editorial bulletin board"
// DESIGN.md aesthetic intact.
//
// Query strategy — most-specific first:
//   1. Title-derived term: normalize the event title into a 2-4 word phrase
//      (strip venue suffixes, punctuation) and search that. A "Splash Park"
//      event becomes "splash park family" → water-play photos. This is always
//      more relevant than the tag slug for niche activity events.
//   2. Tag slug fallback: walk tags in confidence DESC order and try each as
//      "{slug} family". Used when the title query returns no results or no
//      title was supplied.
//
// API guidelines (https://unsplash.com/documentation):
//   - Authenticate with Client-ID <UNSPLASH_ACCESS_KEY>.
//   - Use the orientation=landscape filter for card-shaped photos.
//   - Request per_page=5 and pick randomly to avoid every event with the
//     same primary term getting the identical photo permanently.
//   - Trigger the download-tracking endpoint when a photo is "used" (i.e.
//     persisted into our DB). Tracking is awaited by the caller after the
//     DB write so failures can be retried from persisted attribution rows.
//   - Surface per-photo attribution: "Photo by <photographer> on Unsplash".
//
// Rate limit: 5000 req/hr on the demo tier. At our cron cadence (~25
// events / 15 min = 2400/day) we stay comfortably under.

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

export interface UnsplashAttributionMetadata {
  photoId: string
  photographerName: string
  photographerUsername: string
  photographerProfileUrl: string
  photoUrl: string
  downloadLocation: string
}

export interface UnsplashResult {
  url: string
  /** Search term we matched on (for logging). May be a title-derived term or a tag slug. */
  matchedTag: string
  attribution: UnsplashAttributionMetadata
}

export interface UnsplashTrackingResult {
  ok: boolean
  error: string | null
}

const SEARCH_ENDPOINT = "https://api.unsplash.com/search/photos"
const PHOTOS_ENDPOINT = "https://api.unsplash.com/photos"

function unsplashPhotoIdFromCdnUrl(imageUrl: string): string | null {
  try {
    const { hostname, pathname } = new URL(imageUrl)
    if (!hostname.includes("unsplash.com")) return null
    const match = pathname.match(/\/(photo-[\w-]+)/)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

function firstString(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed) return trimmed
  }
  return null
}

function attributionFromHit(hit: UnsplashSearchHit): UnsplashAttributionMetadata | null {
  const photoId = firstString(hit.id)
  const photographerUsername = firstString(hit.user?.username)
  const photographerName = firstString(hit.user?.name, photographerUsername ?? undefined)
  const photographerProfileUrl = firstString(hit.user?.links?.html)
  const photoUrl = firstString(hit.links?.html)
  const downloadLocation = firstString(hit.links?.download_location)

  if (
    !photoId ||
    !photographerName ||
    !photographerUsername ||
    !photographerProfileUrl ||
    !photoUrl ||
    !downloadLocation
  ) {
    return null
  }

  return {
    photoId,
    photographerName,
    photographerUsername,
    photographerProfileUrl,
    photoUrl,
    downloadLocation,
  }
}

/**
 * Derive a 2-4 word search term from an event title.
 *
 * Strips common venue suffix patterns ("at West Regional Library",
 * "presented by BREC", "hosted by …") and punctuation, then takes the
 * first four words. Returns null when the result is too short to be useful.
 *
 * Examples:
 *   "Splash Park at East Side Recreation Center" → "splash park"
 *   "Story Time for Toddlers at the Library" → "story time for toddlers"
 *   "Community Day" → "community day" (short but still useful)
 */
export function deriveTitleSearchTerm(title: string): string | null {
  const normalized = title
    // Strip "at <Venue>", "presented by …", "hosted by …", "sponsored by …"
    .replace(/\s+(?:at|presented by|hosted by|sponsored by)\b.*/i, "")
    // Strip remaining punctuation (keep spaces and word chars)
    .replace(/[^\w\s]/g, " ")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .join(" ")

  // Require at least 4 characters (filters out single-char noise after stripping)
  return normalized.length >= 4 ? normalized : null
}

export async function trackUnsplashDownload(
  downloadLocation: string,
  accessKey: string,
  options: { fetchImpl?: typeof fetch } = {}
): Promise<UnsplashTrackingResult> {
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

/**
 * Fetch attribution metadata for an existing Unsplash CDN image URL.
 * Extracts the CDN path slug (e.g. "photo-abc123") and calls GET /photos/:id.
 * Returns null on any failure — callers skip and retry next tick.
 */
export async function lookupUnsplashPhotoFromUrl(
  imageUrl: string,
  accessKey: string,
  options: { fetchImpl?: typeof fetch } = {}
): Promise<UnsplashAttributionMetadata | null> {
  if (!accessKey) return null
  const photoId = unsplashPhotoIdFromCdnUrl(imageUrl)
  if (!photoId) return null

  const fetcher = options.fetchImpl ?? fetch
  try {
    const res = await fetcher(`${PHOTOS_ENDPOINT}/${photoId}`, {
      headers: {
        Authorization: `Client-ID ${accessKey}`,
        "Accept-Version": "v1",
      },
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return null
    const hit = (await res.json()) as UnsplashSearchHit
    return attributionFromHit(hit)
  } catch {
    return null
  }
}

/**
 * Resolve a single Unsplash image URL for an event.
 *
 * Search order (most-specific first):
 *   1. Title-derived term — strips venue suffix, normalizes to 2-4 words.
 *      E.g. "Splash Park at East Side Recreation Center" → "splash park family".
 *      Produces the most relevant photos for niche activity events.
 *   2. Tag slugs — walks tags in caller-supplied order (confidence DESC) and
 *      tries "{slug} family" for each. Used as fallback when the title yields
 *      no results or no title was supplied.
 *
 * For each search term we request per_page=5 and pick a result randomly.
 * This prevents all events sharing the same primary term from permanently
 * receiving the identical photo.
 *
 * Returns `null` when the access key is missing, when every candidate misses,
 * or on any network / parse error — the caller treats this as "leave images
 * empty, next tick will retry."
 */
export async function findFallbackImage(
  tags: string[],
  accessKey: string,
  options: { fetchImpl?: typeof fetch; title?: string } = {}
): Promise<UnsplashResult | null> {
  if (!accessKey) return null

  const fetcher = options.fetchImpl ?? fetch

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

  for (const { searchTerm } of queue) {
    // Two-pass strategy for each term:
    // 1. Try bare term first (more specific for activity searches)
    // 2. Fall back to "{term} family" only when bare returns empty
    const attempts = [searchTerm, `${searchTerm} family`]

    for (const query of attempts) {
      const url = `${SEARCH_ENDPOINT}?query=${encodeURIComponent(query)}&orientation=landscape&per_page=5&content_filter=high`

      try {
        const res = await fetcher(url, {
          headers: {
            Authorization: `Client-ID ${accessKey}`,
            "Accept-Version": "v1",
          },
          signal: AbortSignal.timeout(5_000),
        })
        if (!res.ok) continue

        const body = (await res.json()) as UnsplashSearchResponse
        const results = body.results ?? []
        if (results.length === 0) continue

        // Pick randomly among returned results so events sharing the same
        // primary term don't all get the same photo permanently.
        const hit = results[Math.floor(Math.random() * results.length)]
        const photoUrl = hit?.urls?.regular
        if (!hit || !photoUrl) continue

        const attribution = attributionFromHit(hit)
        if (!attribution) continue

        return { url: photoUrl, matchedTag: query, attribution }
      } catch {
        // Network / timeout / parse failure: try the next pass, then next term.
        continue
      }
    }
  }
  return null
}
