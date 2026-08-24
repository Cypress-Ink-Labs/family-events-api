// Enrichment backfill worker: claims a batch of events needing coords/images
// and enriches each one (geocode fallback tiers + tag-keyed stock-image
// fallback chain).
// Ported from family-events-backend supabase/functions/backfill-event-enrichment/index.ts
// lines 106-388 (`enrichOne`) and lines 27, 541-547 (batch split + dedupe) (U29).
//
// Deviations:
// - Deviation #5 (binding plan): legacy's scraper-image-refetch path
//   (index.ts:227-254) is DEAD CODE — `sanitizeImagesForIngest` always
//   returns `[]` because the scrape RPC drops the parser's `images` on
//   insert. Not ported; `enrichOne` goes straight from the coords block to
//   the tag-keyed stock-image fallback, matching legacy's actual runtime
//   behavior exactly.
// - `EnrichmentDb` drops legacy's `fetchSourceUrl`/`sourceCache` (index.ts:93-104,
//   228-231) entirely — they existed only to feed the dead scraper path above.
//   `EnrichmentCandidate.sourceUrl`/`sourceId` are kept on the shape (future
//   tasks may still want them for logging) but `enrichOne` does not read them.
// - `enrichOne` takes no per-tick cache maps (legacy's `cityCache`,
//   `geocodeCache`, `imageCache`, index.ts:577-583) because its signature is
//   fixed to `(db, candidate, deps)` — one candidate per call. Per-tick
//   memoization across multiple `enrichOne` calls in one claimed batch is
//   Task 7's responsibility (it owns the loop over claimed candidates via
//   `runEnrichmentTick`); `enrichOne` always calls `db.getCityContext` and
//   `deps.geocode` directly for its one candidate.
// - `enrichOne` has no internal try/catch, matching legacy: the try/catch
//   lives in the *caller's* loop (index.ts:585-613), not inside `enrichOne`
//   itself. A caller looping over multiple candidates catches per-row errors
//   and continues — see the "row-level throw" test in the paired test file.
// - `EnrichmentTickDependencies.trackDownload`/`lookupPhoto` default to the
//   copies in `../unsplash.js` rather than `../stock-images.js`. Legacy
//   actually has two near-identical `trackUnsplashDownload` implementations
//   (stock-images.ts, used by `enrichOne`, and unsplash.ts, used by the
//   attribution-backfill pass) that are behaviorally identical (same 3s
//   timeout, same success/error shape) — using one module as the single
//   source for both Unsplash-specific helpers is a no-op behavior change.
//   `findImage` still defaults to `../stock-images.js`'s multi-provider
//   `findFallbackImage`, matching legacy's actual `enrichOne` import exactly.

import { buildGeocodeQuery, geocodeViaNominatim, type GeocodeResult } from "../geocode.js"
import type { EnvReader } from "../llm-config.js"
import { errorMessage, logEdgeEvent } from "../logger.js"
import {
  findFallbackImage,
  type StockImageProviderKeys,
  type StockImageResult,
  type StockProvider,
} from "../stock-images.js"
import { lookupUnsplashPhotoFromUrl, trackUnsplashDownload } from "../unsplash.js"
import {
  generateParentTipsForEvent,
  resolveParentTipsAiConfig,
  type ParentTipsCandidate,
  type ParentTipsDb,
} from "./generate-parent-tips.js"

// Cap batch so per-tick wall stays under 90s with headroom under the 150s
// edge wall (index.ts:23-27).
export const DEFAULT_ENRICHMENT_BATCH = 25

export interface EnrichmentCandidate {
  eventId: string
  title: string
  description: string | null
  venueName: string | null
  address: string | null
  cityId: string | null
  sourceId: string | null
  sourceUrl: string | null
  needsCoords: boolean
  needsImages: boolean
  adminLockedFields: string[]
  tags: string[]
}

export interface UnsplashAttributionUpsert {
  eventId: string
  latitude: number | null
  longitude: number | null
  images: string[]
  imageUrl: string
  unsplashPhotoId: string
  photographerName: string
  photographerUsername: string
  photographerProfileUrl: string
  photoUrl: string
  downloadLocation: string
  matchedTag: string | null
}

/**
 * Attribution recovered by URL lookup for an event that already has an
 * Unsplash image but is missing its attribution row (`enrichOne`'s RPC path
 * never ran for it — e.g. seeded before attribution tracking existed).
 * Unlike `UnsplashAttributionUpsert` this carries no lat/lng/images: the
 * event's enrichment fields are untouched, only the attribution row is
 * backfilled. Ported from legacy's client-side upsert (index.ts:469-485).
 */
export interface UnsplashAttributionBackfillUpsert {
  eventId: string
  imageUrl: string
  unsplashPhotoId: string
  photographerName: string
  photographerUsername: string
  photographerProfileUrl: string
  photoUrl: string
  downloadLocation: string
}

export interface ProviderImageAttributionUpsert {
  eventId: string
  imageUrl: string
  provider: "pexels" | "pixabay"
  matchedTag: string | null
  pexelsPhotoId: string | null
  pexelsPhotographerName: string | null
  pexelsPhotographerProfileUrl: string | null
  pexelsPhotoUrl: string | null
  pixabayPhotoId: string | null
  pixabayPhotographerName: string | null
  pixabayPhotographerUsername: string | null
  pixabayPhotoUrl: string | null
}

export interface EnrichmentDb extends ParentTipsDb {
  /** private.list_events_needing_enrichment(p_limit) */
  listEventsNeedingEnrichment(limit: number): Promise<EnrichmentCandidate[]>
  /** private.backfill_image_enrichment_in_scope(p_limit) */
  listImageEnrichmentInScope(limit: number): Promise<EnrichmentCandidate[]>
  /** SELECT name, state FROM public.cities WHERE id = $1 — legacy fetched city context for buildGeocodeQuery, cached per tick. */
  getCityContext(cityId: string): Promise<{ name: string; state: string | null } | null>
  /** private.update_event_enrichment(p_event_id, p_latitude, p_longitude, p_images) */
  updateEventEnrichment(
    eventId: string,
    latitude: number | null,
    longitude: number | null,
    images: string[] | null
  ): Promise<void>
  /** private.upsert_event_image_attribution_with_enrichment(...) — returns the attribution id (or null). */
  upsertUnsplashAttributionWithEnrichment(params: UnsplashAttributionUpsert): Promise<string | null>
  /** Direct upsert into event_image_attributions ON CONFLICT (event_id, image_url) — legacy did this client-side for pexels/pixabay, no RPC exists. */
  upsertProviderImageAttribution(params: ProviderImageAttributionUpsert): Promise<void>
  /** private.list_pending_unsplash_download_tracking(p_limit) */
  listPendingUnsplashTracking(limit: number): Promise<
    Array<{
      attributionId: string
      eventId: string
      imageUrl: string
      downloadLocation: string
      attempts: number
    }>
  >
  /** private.mark_unsplash_download_tracking_result(p_attribution_id, p_success, p_error) */
  markUnsplashTrackingResult(attributionId: string, success: boolean, error?: string): Promise<void>
  /** private.list_events_needing_attribution_backfill(p_limit) */
  listEventsNeedingAttributionBackfill(
    limit: number
  ): Promise<Array<{ eventId: string; imageUrl: string }>>
  /**
   * Direct upsert into event_image_attributions ON CONFLICT (event_id,
   * image_url) — legacy did this client-side (index.ts:469-485), also
   * setting download_tracking_status='pending' + a next-attempt timestamp
   * server-side so the tracking pass claims the row on a later tick.
   */
  upsertUnsplashAttributionBackfill(params: UnsplashAttributionBackfillUpsert): Promise<void>
}

/**
 * Dependencies shared by `enrichOne`/`claimEnrichmentBatch` (Task 6) and
 * `runEnrichmentTick`'s auxiliary passes (Task 7). Every network helper is
 * injectable and defaults to the real module function so production callers
 * only need to supply provider keys and env.
 */
export interface EnrichmentTickDependencies {
  providerKeys: StockImageProviderKeys
  /**
   * Legacy derives a single `unsplashAccessKey = providerKeys.unsplash ?? ""`
   * local var and reuses it for `enrichOne`'s download-tracking call *and*
   * both Task 7 aux passes (index.ts:535, 615-623). This dependency shape
   * splits that into a dedicated field for the aux passes (`enrichOne` reads
   * `providerKeys.unsplash` directly, see above) — production callers must
   * supply the same key in both places.
   */
  unsplashAccessKey?: string
  parentTipsEnv?: EnvReader
  geocode?: typeof geocodeViaNominatim
  findImage?: typeof findFallbackImage
  trackDownload?: typeof trackUnsplashDownload
  lookupPhoto?: typeof lookupUnsplashPhotoFromUrl
  fetchImpl?: typeof fetch
  /** Legacy DEFAULT_BATCH = 25 (index.ts:27). */
  batchSize?: number
  /** Task 7 parent-tips pass batch size. */
  parentTipsBatch?: number
  /** Legacy ATTRIBUTION_BACKFILL_BATCH = 10 (index.ts:437). */
  attributionBackfillBatch?: number
  /** Legacy `list_pending_unsplash_download_tracking` p_limit = 25 (index.ts:404). */
  trackingBatch?: number
  /**
   * Plan deviation #4's invented safety-net default (110_000ms) — there is no
   * `BUDGET_MS` constant anywhere in legacy `backfill-event-enrichment`
   * (that name belongs to the unrelated `backfill-embeddings` function).
   * Legacy relies solely on capping `DEFAULT_BATCH` to stay under the
   * Supabase edge platform's wall-clock limit; see `runEnrichmentTick`'s
   * JSDoc for the full rationale.
   */
  budgetMs?: number
  now?: () => number
}

/**
 * Two-pass claim + dedupe. Ported from legacy `Deno.serve` body
 * (index.ts:541-564): split the requested batch in half across two RPCs run
 * in parallel — `list_events_needing_enrichment` orders by created_at DESC
 * (can starve rows that already have coords but need images when many
 * recently-scraped rows still need coords), while
 * `backfill_image_enrichment_in_scope` narrows to featured + next-30-day
 * rows so the user-facing surface fills first. Rows are deduped by eventId;
 * the legacy list wins ties (its rows are appended to the result first).
 */
export async function claimEnrichmentBatch(
  db: EnrichmentDb,
  batchSize: number
): Promise<EnrichmentCandidate[]> {
  const halfBatch = Math.max(1, Math.floor(batchSize / 2))
  const [legacyRows, scopedRows] = await Promise.all([
    db.listEventsNeedingEnrichment(halfBatch),
    db.listImageEnrichmentInScope(halfBatch),
  ])

  const seen = new Set<string>()
  const rows: EnrichmentCandidate[] = []
  for (const row of legacyRows) {
    if (seen.has(row.eventId)) continue
    seen.add(row.eventId)
    rows.push(row)
  }
  for (const row of scopedRows) {
    if (seen.has(row.eventId)) continue
    seen.add(row.eventId)
    rows.push(row)
  }
  // Finding F5: each half-claim independently applies `Math.max(1, floor(n/2))`,
  // so a small `batchSize` (e.g. 1) can produce two half-claims of 1 row each
  // that dedupe to 2 distinct rows — more than `batchSize`. Cap after dedupe
  // so `batchSize` is a real upper bound; a no-op for the default batch (24
  // deduped legacy+scoped rows never exceeds 25).
  return rows.slice(0, batchSize)
}

export interface EnrichOneOutcome {
  coordsSet: boolean
  imagesSet: boolean
  provider: StockProvider | null
  /**
   * True when nothing changed and the only write was the attempt-timestamp
   * bump (legacy's early-return branch, index.ts:284-299 — no `updated`
   * output field in that branch). False whenever coords and/or images were
   * actually written.
   */
  attempted: boolean
}

/**
 * Per-tick memoization caches threaded from `runEnrichmentTick` into every
 * `enrichOne` call for one claimed batch (finding F2). Ported from legacy's
 * `geocodeCache` (index.ts:109-229, keyed on the exact query string built by
 * `buildGeocodeQuery`) and `imageCache` (index.ts:256-279, keyed on
 * `[...tags].sort().join(",")`). Both legacy caches store hits AND misses —
 * see the comment at index.ts:142-144: "a venue that fails to geocode should
 * not be retried for every event in the same batch." Optional and defaulted
 * to fresh empty maps so single-call unit tests don't need to construct them.
 *
 * Legacy's third per-tick cache, `sourceCache` (index.ts:93-104, 228-231), is
 * intentionally NOT ported here: it exists solely to feed `fetchSourceUrl`
 * for the scraper-image-refetch path, which is dead code per deviation #5
 * (file header) — `EnrichmentDb` already dropped `fetchSourceUrl` entirely,
 * so there is nothing left for a `sourceCache` to memoize.
 */
export interface EnrichOneCaches {
  geocodeCache?: Map<string, GeocodeResult | null>
  imageCache?: Map<string, StockImageResult | null>
}

/**
 * Enrich one candidate: geocode fallback tiers for coords, tag-keyed stock
 * image fallback chain for images, then the write path selected by what (if
 * anything) was produced. Ported from legacy `enrichOne`
 * (index.ts:106-388) minus the dead scraper-image path (deviation #5 above).
 */
export async function enrichOne(
  db: EnrichmentDb,
  candidate: EnrichmentCandidate,
  deps: EnrichmentTickDependencies,
  caches: EnrichOneCaches = {}
): Promise<EnrichOneOutcome> {
  const geocode = deps.geocode ?? geocodeViaNominatim
  const findImage = deps.findImage ?? findFallbackImage
  const trackDownload = deps.trackDownload ?? trackUnsplashDownload
  const geocodeCache = caches.geocodeCache ?? new Map<string, GeocodeResult | null>()
  const imageCache = caches.imageCache ?? new Map<string, StockImageResult | null>()

  // Both hits and misses are cached — a venue that fails to geocode should
  // not be retried for every event in the same batch (index.ts:142-144).
  const cachedGeocode = async (query: string): Promise<GeocodeResult | null> => {
    if (geocodeCache.has(query)) return geocodeCache.get(query) ?? null
    const result = await geocode(query)
    geocodeCache.set(query, result)
    return result
  }

  let latitude: number | null = null
  let longitude: number | null = null
  let images: string[] = []
  let imageSource: StockProvider | null = null
  let stockResult: StockImageResult | null = null

  if (candidate.needsCoords) {
    const cityCtx = candidate.cityId ? await db.getCityContext(candidate.cityId) : null

    // Tier 1: full address/venue + city context (index.ts:135-151).
    const query = buildGeocodeQuery({
      address: candidate.address,
      venueName: candidate.venueName,
      cityName: cityCtx?.name ?? null,
      cityState: cityCtx?.state ?? null,
    })

    if (query) {
      const geo = await cachedGeocode(query)
      if (geo) {
        latitude = geo.latitude
        longitude = geo.longitude
      } else {
        // Tier 2: "Room Name, Branch Name" venues confuse Nominatim on the
        // room prefix — strip everything up to the last comma and retry
        // with just the branch name (index.ts:156-186).
        const raw = candidate.venueName ?? candidate.address
        if (raw) {
          const lastComma = raw.lastIndexOf(",")
          if (lastComma !== -1) {
            const branchName = raw.substring(lastComma + 1).trim()
            if (branchName) {
              const fallbackQuery = buildGeocodeQuery({
                address: null,
                venueName: branchName,
                cityName: cityCtx?.name ?? null,
                cityState: cityCtx?.state ?? null,
              })
              if (fallbackQuery) {
                const fallbackGeo = await cachedGeocode(fallbackQuery)
                if (fallbackGeo) {
                  latitude = fallbackGeo.latitude
                  longitude = fallbackGeo.longitude
                }
              }
            }
          }
        }
      }
    }

    // Tier 3: venue name alone, no city context. Some venues embed a
    // different city in their name than event.city_id, and Nominatim
    // rejects a query when the appended city contradicts the venue's actual
    // location (index.ts:190-216).
    if (latitude === null && candidate.venueName) {
      const venueOnlyQuery = buildGeocodeQuery({
        address: null,
        venueName: candidate.venueName,
        cityName: null,
        cityState: null,
      })
      if (venueOnlyQuery && venueOnlyQuery !== query) {
        const venueGeo = await cachedGeocode(venueOnlyQuery)
        if (venueGeo) {
          latitude = venueGeo.latitude
          longitude = venueGeo.longitude
        }
      }
    }

    // Intentionally no city-centroid fallback here. Writing the centroid
    // back re-flags the row as needs_coords (centroid match) and the claim
    // queue re-served the same rows every tick, starving the rest of the
    // backlog. Scrape already seeds the centroid on insert; if the geocode
    // misses we leave the row at its existing coords and the
    // attempt-timestamp bump (markEnrichmentAttempt below) rotates it to the
    // back of the queue so other rows get a turn. (index.ts:218-224)
  }

  // Deviation #5 (binding plan, see file header): legacy's scraper-image
  // path (index.ts:227-254) is dead code — go straight to the tag-keyed
  // stock-image fallback (index.ts:256-279).
  if (candidate.needsImages && candidate.tags.length > 0) {
    // Cache keyed on sorted tag slugs — events sharing the same tag set are
    // thematically identical, so reusing the result (hit or miss) is
    // acceptable within one tick (index.ts:256-267).
    const imageKey = [...candidate.tags].sort().join(",")
    if (imageCache.has(imageKey)) {
      stockResult = imageCache.get(imageKey) ?? null
    } else {
      stockResult = await findImage(candidate.tags, deps.providerKeys, { title: candidate.title })
      imageCache.set(imageKey, stockResult)
    }
    if (stockResult) {
      images = [stockResult.url]
      imageSource = stockResult.attribution.provider
    }
  }

  const gotCoords = latitude !== null && longitude !== null
  const gotImages = images.length > 0

  // Nothing to write: bump the attempt timestamp so the row rotates to the
  // back of the claim queue (index.ts:284-299).
  if (!gotCoords && !gotImages) {
    await db.markEnrichmentAttempt(candidate.eventId)
    return { coordsSet: false, imagesSet: false, provider: null, attempted: true }
  }

  if (imageSource === "unsplash" && stockResult) {
    // Unsplash: attribution + enrichment write happen together via RPC, then
    // download tracking is fired and its result recorded (index.ts:305-343).
    const attributionId = await db.upsertUnsplashAttributionWithEnrichment({
      eventId: candidate.eventId,
      latitude,
      longitude,
      images,
      imageUrl: stockResult.url,
      unsplashPhotoId: stockResult.attribution.photoId,
      photographerName: stockResult.attribution.photographerName,
      photographerUsername: stockResult.attribution.photographerUsername ?? "",
      photographerProfileUrl: stockResult.attribution.photographerProfileUrl,
      photoUrl: stockResult.attribution.photoUrl,
      downloadLocation: stockResult.attribution.downloadLocation ?? "",
      matchedTag: stockResult.matchedTag,
    })

    if (attributionId && stockResult.attribution.downloadLocation) {
      const tracking = await trackDownload(
        stockResult.attribution.downloadLocation,
        deps.providerKeys.unsplash ?? ""
      )
      await db.markUnsplashTrackingResult(attributionId, tracking.ok, tracking.error ?? undefined)
    }
  } else if ((imageSource === "pexels" || imageSource === "pixabay") && stockResult) {
    // Pexels/Pixabay: enrichment write first, then a direct attribution
    // upsert (no download tracking needed) (index.ts:344-376).
    await db.updateEventEnrichment(
      candidate.eventId,
      latitude,
      longitude,
      images.length > 0 ? images : null
    )
    await db.upsertProviderImageAttribution({
      eventId: candidate.eventId,
      imageUrl: stockResult.url,
      provider: imageSource,
      matchedTag: stockResult.matchedTag,
      pexelsPhotoId: imageSource === "pexels" ? stockResult.attribution.photoId : null,
      pexelsPhotographerName:
        imageSource === "pexels" ? stockResult.attribution.photographerName : null,
      pexelsPhotographerProfileUrl:
        imageSource === "pexels" ? stockResult.attribution.photographerProfileUrl : null,
      pexelsPhotoUrl: imageSource === "pexels" ? stockResult.attribution.photoUrl : null,
      pixabayPhotoId: imageSource === "pixabay" ? stockResult.attribution.photoId : null,
      pixabayPhotographerName:
        imageSource === "pixabay" ? stockResult.attribution.photographerName : null,
      // Defensive `?? null` (legacy assigns `undefined` here, index.ts:371):
      // searchPixabay always sets photographerUsername in practice, but the
      // DB param type is `string | null`, not `string | undefined`.
      pixabayPhotographerUsername:
        imageSource === "pixabay" ? (stockResult.attribution.photographerUsername ?? null) : null,
      pixabayPhotoUrl: imageSource === "pixabay" ? stockResult.attribution.photoUrl : null,
    })
  } else {
    // Coords only — no image write needed (index.ts:377-385).
    await db.updateEventEnrichment(
      candidate.eventId,
      latitude,
      longitude,
      images.length > 0 ? images : null
    )
  }

  return { coordsSet: gotCoords, imagesSet: gotImages, provider: imageSource, attempted: false }
}

export interface EnrichmentTickSummary {
  claimed: number
  coordsSet: number
  imagesSet: number
  attemptsMarked: number
  errors: number
  tracking: { processed: number; succeeded: number; failed: number }
  attributionBackfill: { processed: number; upserted: number; skipped: number; errors: number }
  parentTips: { enabled: boolean; generated: number; errors: number }
  durationMs: number
  stoppedEarly: boolean
}

/**
 * Wrap `db` so `getCityContext` is memoized per `cityId` for the lifetime of
 * one tick. `enrichOne` (Task 6) always calls `db.getCityContext` directly —
 * its signature has no cache-map parameter (see the file-header deviation
 * note) — so per-tick memoization has to live here, one layer up, wrapping
 * the db instance passed into each `enrichOne` call. Legacy cached city
 * context the same way, keyed on `city_id`, across every row of one
 * invocation (index.ts:127-133, `cityCache`).
 *
 * Implemented via `Proxy` rather than `Object.create` delegation:
 * `Object.create(db)` makes every forwarded method run with `this = wrapped`
 * (the proxy-free prototype child), not `this = db` — which throws on any
 * real `EnrichmentDb` implementation that reads a native private class field
 * (`#foo`) inside a method, since private fields are only reachable through
 * the exact instance that declared them. The `get` trap below returns every
 * method pre-bound to the real `db` instance, so `this` is preserved for all
 * forwarded calls; only `getCityContext` is swapped for the caching closure
 * (which itself calls `db.getCityContext(cityId)` as a normal method call,
 * so `this` is `db` there too).
 */
function withCityContextCache(db: EnrichmentDb): EnrichmentDb {
  const cache = new Map<string, { name: string; state: string | null } | null>()
  const cachedGetCityContext = async (
    cityId: string
  ): Promise<{ name: string; state: string | null } | null> => {
    if (cache.has(cityId)) return cache.get(cityId) ?? null
    const result = await db.getCityContext(cityId)
    cache.set(cityId, result)
    return result
  }

  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "getCityContext") return cachedGetCityContext
      const value = Reflect.get(target, prop, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

/**
 * Shared wall-clock budget check (plan deviation #4, binding; finding F1).
 * `runEnrichmentTick`'s JSDoc covers the rationale; this type/factory exists
 * so every call site — the main claim loop, the entry to each auxiliary
 * pass, and the between-rows check inside each aux pass's own loop — shares
 * one `now()` reading and one `budgetMs` threshold rather than re-deriving
 * the check ad hoc (the bug fixed here: previously only the main loop
 * checked it, so time spent inside an aux pass, or past the last main row,
 * ran unbounded).
 */
interface Deadline {
  exceeded(): boolean
}

function createDeadline(now: () => number, startedAt: number, budgetMs: number): Deadline {
  return {
    exceeded: () => now() - startedAt >= budgetMs,
  }
}

/**
 * Ported from legacy `runPendingUnsplashTrackingPass` (index.ts:390-423): no
 * key configured means the pass is a no-op (legacy's early `return summary`
 * before the RPC call). Finding F1: checks the shared `deadline` between
 * rows so a slow tracking pass can't blow through the tick's budget.
 */
async function runTrackingPass(
  db: EnrichmentDb,
  deps: EnrichmentTickDependencies,
  deadline: Deadline
): Promise<{ summary: EnrichmentTickSummary["tracking"]; stoppedEarly: boolean }> {
  const summary = { processed: 0, succeeded: 0, failed: 0 }
  const unsplashAccessKey = deps.unsplashAccessKey ?? ""
  if (!unsplashAccessKey) return { summary, stoppedEarly: false }

  const trackDownload = deps.trackDownload ?? trackUnsplashDownload
  const rows = await db.listPendingUnsplashTracking(deps.trackingBatch ?? 25)
  summary.processed = rows.length

  for (const row of rows) {
    if (deadline.exceeded()) return { summary, stoppedEarly: true }
    try {
      const result = await trackDownload(row.downloadLocation, unsplashAccessKey)
      await db.markUnsplashTrackingResult(row.attributionId, result.ok, result.error ?? undefined)
      if (result.ok) summary.succeeded += 1
      else summary.failed += 1
    } catch (rowErr) {
      summary.failed += 1
      logEdgeEvent("warn", "unsplash tracking row failed", {
        function: "backfill-event-enrichment",
        stage: "tracking",
        attributionId: row.attributionId,
        error: errorMessage(rowErr),
      })
    }
  }

  return { summary, stoppedEarly: false }
}

/**
 * Ported from legacy `runUnsplashAttributionBackfillPass` (index.ts:439-499).
 * Legacy's per-row outcome has three buckets: `backfilled`, `skipped` (null
 * lookup, index.ts:464-467 — "if (!attribution) { summary.skipped += 1;
 * continue }"), and `errors` (thrown/upsert failure). CONTROLLER RULING P1
 * (binding, overrides the plan brief's "null lookup counted as error"
 * wording — finding F4): legacy wins, a null lookup is counted as `skipped`.
 *
 * Finding F1: checks the shared `deadline` between rows.
 */
async function runAttributionBackfillPass(
  db: EnrichmentDb,
  deps: EnrichmentTickDependencies,
  deadline: Deadline
): Promise<{ summary: EnrichmentTickSummary["attributionBackfill"]; stoppedEarly: boolean }> {
  const summary = { processed: 0, upserted: 0, skipped: 0, errors: 0 }
  const unsplashAccessKey = deps.unsplashAccessKey ?? ""
  if (!unsplashAccessKey) return { summary, stoppedEarly: false }

  const lookupPhoto = deps.lookupPhoto ?? lookupUnsplashPhotoFromUrl
  const rows = await db.listEventsNeedingAttributionBackfill(deps.attributionBackfillBatch ?? 10)
  summary.processed = rows.length

  for (const row of rows) {
    if (deadline.exceeded()) return { summary, stoppedEarly: true }
    try {
      const attribution = await lookupPhoto(row.imageUrl, unsplashAccessKey)
      if (!attribution) {
        // Legacy: null lookup is "skipped", not an error (index.ts:464-467).
        summary.skipped += 1
        continue
      }
      await db.upsertUnsplashAttributionBackfill({
        eventId: row.eventId,
        imageUrl: row.imageUrl,
        unsplashPhotoId: attribution.photoId,
        photographerName: attribution.photographerName,
        photographerUsername: attribution.photographerUsername,
        photographerProfileUrl: attribution.photographerProfileUrl,
        photoUrl: attribution.photoUrl,
        downloadLocation: attribution.downloadLocation,
      })
      summary.upserted += 1
    } catch (rowErr) {
      summary.errors += 1
      logEdgeEvent("warn", "attribution backfill row failed", {
        function: "backfill-event-enrichment",
        stage: "attribution-backfill",
        eventId: row.eventId,
        error: errorMessage(rowErr),
      })
    }
  }

  return { summary, stoppedEarly: false }
}

/**
 * Ported from legacy `parent-tips-pass.ts:23-110`, restructured for the
 * in-process config the CONTROLLER RULING P2 (binding, replaces the task
 * brief's literal "break after first row" wording) mandates:
 *
 * Legacy resolved the AI config *inside* another edge function
 * (`generate-parent-tips`) reached over HTTP, so the only way for this pass
 * to discover "not configured" was to invoke it for one row, read back a 503,
 * count it as one error, and `break` (parent-tips-pass.ts:71-75) — leaving
 * the rest of the claimed batch untouched until config changed.
 *
 * In-process, `resolveParentTipsAiConfig` is a pure function of the DB
 * feature row + env — this pass calls it exactly once per tick, before
 * touching `listEventsNeedingParentTips` at all. When
 * `configured === false` there is nothing a per-row probe could learn that
 * the config resolution didn't already know, so probing would be artificial:
 * report `{ enabled: true, generated: 0, errors: 1 }` and skip the list/
 * generate calls entirely.
 *
 * Finding F3: legacy's HTTP boundary made three seam-throw scenarios
 * impossible; in-process they are real, and the tick must never reject:
 * - `loadParentTipsFeatureConfig` throws -> legacy's `cfgErr`
 *   (parent-tips-pass.ts:31-39, `if (cfgErr || !cfg || cfg.enabled !== true)
 *   return summary`): treated exactly like "not configured" — return the
 *   untouched default summary.
 * - `listEventsNeedingParentTips` throws -> legacy's `claimErr`
 *   (parent-tips-pass.ts:42-52): `summary.enabled` stays `true` (already set
 *   before this call, matching legacy), log a warning, return without
 *   incrementing `errors`.
 * - the per-row `generateParentTipsForEvent` call throws (its own try/catch
 *   covers the LLM call and DB write, but prompt-building runs *outside*
 *   that try/catch and can throw on malformed candidate data) -> legacy's
 *   per-row catch (parent-tips-pass.ts:98-106, `catch (rowErr) { errors += 1;
 *   log; }` then loop `continue`s): `errors += 1`, log, continue — no
 *   `markEnrichmentAttempt` call (unlike the sibling non-thrown-failure
 *   branch below, which does call it, matching parent-tips-pass.ts:76-94).
 *
 * Finding F1: also checks the shared `deadline` between rows of the generate
 * loop, matching the main claim loop's between-rows check.
 */
async function runParentTipsPass(
  db: EnrichmentDb,
  deps: EnrichmentTickDependencies,
  deadline: Deadline
): Promise<{ summary: EnrichmentTickSummary["parentTips"]; stoppedEarly: boolean }> {
  const summary: EnrichmentTickSummary["parentTips"] = {
    enabled: false,
    generated: 0,
    errors: 0,
  }

  let dbConfig: { modelId: string | null; provider: string | null; enabled: boolean } | null
  try {
    dbConfig = await db.loadParentTipsFeatureConfig()
  } catch (err) {
    // Legacy cfgErr (parent-tips-pass.ts:37-39): treated as "not configured" — silent no-op.
    logEdgeEvent("warn", "parent-tips config load failed", {
      function: "backfill-event-enrichment",
      stage: "parent-tips",
      error: errorMessage(err),
    })
    return { summary, stoppedEarly: false }
  }
  if (!dbConfig || !dbConfig.enabled) return { summary, stoppedEarly: false }
  summary.enabled = true

  const config = resolveParentTipsAiConfig(dbConfig, deps.parentTipsEnv)
  if (!config.configured) {
    // CONTROLLER RULING P2 — see the function-level doc comment above.
    summary.errors = 1
    return { summary, stoppedEarly: false }
  }

  let rows: ParentTipsCandidate[]
  try {
    rows = await db.listEventsNeedingParentTips(deps.parentTipsBatch ?? 8)
  } catch (err) {
    // Legacy claimErr (parent-tips-pass.ts:42-52): log + return, `enabled`
    // stays true, `errors` is NOT incremented — matching legacy exactly.
    logEdgeEvent("warn", "parent-tips claim failed", {
      function: "backfill-event-enrichment",
      stage: "parent-tips",
      error: errorMessage(err),
    })
    return { summary, stoppedEarly: false }
  }

  for (const row of rows) {
    if (deadline.exceeded()) return { summary, stoppedEarly: true }
    try {
      const result = await generateParentTipsForEvent(db, row, config, {
        fetchImpl: deps.fetchImpl,
      })
      if (result.status === "generated") {
        summary.generated += 1
      } else {
        // Legacy: non-503 failure → count error, mark attempt, continue
        // (parent-tips-pass.ts:76-94). The mark-attempt call itself is
        // guarded the same way legacy guards it (parent-tips-pass.ts:80-93):
        // a failure there logs a warning and the loop continues — it must
        // never crash the whole tick.
        summary.errors += 1
        try {
          await db.markEnrichmentAttempt(row.eventId)
        } catch (markErr) {
          logEdgeEvent("warn", "parent-tips mark attempt failed", {
            function: "backfill-event-enrichment",
            stage: "parent-tips",
            eventId: row.eventId,
            error: errorMessage(markErr),
          })
        }
      }
    } catch (rowErr) {
      // Legacy's outer per-row catch (parent-tips-pass.ts:98-106): count
      // error, log, continue. No markEnrichmentAttempt here — legacy's outer
      // catch doesn't call it either.
      summary.errors += 1
      logEdgeEvent("warn", "parent-tips row failed", {
        function: "backfill-event-enrichment",
        stage: "parent-tips",
        eventId: row.eventId,
        error: errorMessage(rowErr),
      })
    }
  }

  return { summary, stoppedEarly: false }
}

/**
 * One backfill tick: claim a batch, enrich each candidate (coords/images),
 * then run the three auxiliary passes in legacy's exact order (main batch →
 * tracking → attribution backfill → parent-tips, index.ts:585-630).
 *
 * Deviation #4 (plan, binding): legacy has no runtime wall-clock budget
 * check at all — it relies solely on capping `DEFAULT_BATCH` to stay under
 * the Supabase edge platform's 150s wall (index.ts:23-27 comment). This port
 * doesn't run under that same platform guarantee, so a graceful
 * `budgetMs` (default 110_000) check runs between rows of the main batch:
 * once elapsed time reaches the budget, the remaining claimed rows are
 * skipped with no DB writes ("releaseless" — they simply stay claimed for
 * the next tick to re-list), all three aux passes are skipped for this tick,
 * and `stoppedEarly` is set so callers/observability can tell a tick was cut
 * short rather than completing normally with a small batch.
 *
 * Finding F1 (fixed here): the original version only checked the budget
 * between main-batch rows, so a slow last row or a slow aux pass (up to 8
 * parent-tips rows × a 30s LLM timeout each) could run the tick unbounded.
 * The shared `deadline` (see `createDeadline` above) is now re-checked
 * immediately before each aux pass is *entered*, and each pass itself
 * re-checks it between its own rows — tripping the budget anywhere skips all
 * remaining work and latches `stoppedEarly = true` for the rest of the tick.
 */
export async function runEnrichmentTick(
  db: EnrichmentDb,
  deps: EnrichmentTickDependencies
): Promise<EnrichmentTickSummary> {
  const now = deps.now ?? Date.now
  const startedAt = now()
  const budgetMs = deps.budgetMs ?? 110_000
  const deadline = createDeadline(now, startedAt, budgetMs)

  const summary: EnrichmentTickSummary = {
    claimed: 0,
    coordsSet: 0,
    imagesSet: 0,
    attemptsMarked: 0,
    errors: 0,
    tracking: { processed: 0, succeeded: 0, failed: 0 },
    attributionBackfill: { processed: 0, upserted: 0, skipped: 0, errors: 0 },
    parentTips: { enabled: false, generated: 0, errors: 0 },
    durationMs: 0,
    stoppedEarly: false,
  }

  const candidates = await claimEnrichmentBatch(db, deps.batchSize ?? DEFAULT_ENRICHMENT_BATCH)
  summary.claimed = candidates.length

  const cityCachedDb = withCityContextCache(db)
  // Finding F2: per-tick geocode + image memoization, shared across every
  // `enrichOne` call in this batch — see `EnrichOneCaches`'s doc comment.
  const geocodeCache = new Map<string, GeocodeResult | null>()
  const imageCache = new Map<string, StockImageResult | null>()

  for (const candidate of candidates) {
    if (deadline.exceeded()) {
      summary.stoppedEarly = true
      break
    }
    try {
      const outcome = await enrichOne(cityCachedDb, candidate, deps, { geocodeCache, imageCache })
      if (outcome.coordsSet) summary.coordsSet += 1
      if (outcome.imagesSet) summary.imagesSet += 1
      if (outcome.attempted) summary.attemptsMarked += 1
    } catch (rowErr) {
      summary.errors += 1
      logEdgeEvent("warn", "enrichment row failed", {
        function: "backfill-event-enrichment",
        stage: "main-batch",
        eventId: candidate.eventId,
        error: errorMessage(rowErr),
      })
    }
  }

  if (!summary.stoppedEarly && !deadline.exceeded()) {
    const trackingResult = await runTrackingPass(db, deps, deadline)
    summary.tracking = trackingResult.summary
    if (trackingResult.stoppedEarly) summary.stoppedEarly = true
  } else {
    summary.stoppedEarly = true
  }

  if (!summary.stoppedEarly && !deadline.exceeded()) {
    const backfillResult = await runAttributionBackfillPass(db, deps, deadline)
    summary.attributionBackfill = backfillResult.summary
    if (backfillResult.stoppedEarly) summary.stoppedEarly = true
  } else {
    summary.stoppedEarly = true
  }

  if (!summary.stoppedEarly && !deadline.exceeded()) {
    const parentTipsResult = await runParentTipsPass(db, deps, deadline)
    summary.parentTips = parentTipsResult.summary
    if (parentTipsResult.stoppedEarly) summary.stoppedEarly = true
  } else {
    summary.stoppedEarly = true
  }

  summary.durationMs = now() - startedAt
  return summary
}
