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

import { buildGeocodeQuery, geocodeViaNominatim } from "../geocode.js"
import type { EnvReader } from "../llm-config.js"
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
  /** Legacy BUDGET_MS = 110_000. */
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
  return rows
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
 * Enrich one candidate: geocode fallback tiers for coords, tag-keyed stock
 * image fallback chain for images, then the write path selected by what (if
 * anything) was produced. Ported from legacy `enrichOne`
 * (index.ts:106-388) minus the dead scraper-image path (deviation #5 above).
 */
export async function enrichOne(
  db: EnrichmentDb,
  candidate: EnrichmentCandidate,
  deps: EnrichmentTickDependencies
): Promise<EnrichOneOutcome> {
  const geocode = deps.geocode ?? geocodeViaNominatim
  const findImage = deps.findImage ?? findFallbackImage
  const trackDownload = deps.trackDownload ?? trackUnsplashDownload

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
      const geo = await geocode(query)
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
                const fallbackGeo = await geocode(fallbackQuery)
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
        const venueGeo = await geocode(venueOnlyQuery)
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
    stockResult = await findImage(candidate.tags, deps.providerKeys, { title: candidate.title })
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
  attributionBackfill: { processed: number; upserted: number; errors: number }
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
 * Implemented via `Object.create` (prototype delegation) rather than object
 * spread: `db` is typically a class instance whose methods live on its
 * prototype, not as own enumerable properties, so `{ ...db }` would silently
 * drop every method but the cached override.
 */
function withCityContextCache(db: EnrichmentDb): EnrichmentDb {
  const cache = new Map<string, { name: string; state: string | null } | null>()
  const wrapped = Object.create(db) as EnrichmentDb
  wrapped.getCityContext = async (cityId: string) => {
    if (cache.has(cityId)) return cache.get(cityId) ?? null
    const result = await db.getCityContext(cityId)
    cache.set(cityId, result)
    return result
  }
  return wrapped
}

/**
 * Ported from legacy `runPendingUnsplashTrackingPass` (index.ts:390-423): no
 * key configured means the pass is a no-op (legacy's early `return summary`
 * before the RPC call).
 */
async function runTrackingPass(
  db: EnrichmentDb,
  deps: EnrichmentTickDependencies
): Promise<EnrichmentTickSummary["tracking"]> {
  const summary = { processed: 0, succeeded: 0, failed: 0 }
  const unsplashAccessKey = deps.unsplashAccessKey ?? ""
  if (!unsplashAccessKey) return summary

  const trackDownload = deps.trackDownload ?? trackUnsplashDownload
  const rows = await db.listPendingUnsplashTracking(deps.trackingBatch ?? 25)
  summary.processed = rows.length

  for (const row of rows) {
    const result = await trackDownload(row.downloadLocation, unsplashAccessKey)
    await db.markUnsplashTrackingResult(row.attributionId, result.ok, result.error ?? undefined)
    if (result.ok) summary.succeeded += 1
    else summary.failed += 1
  }

  return summary
}

/**
 * Ported from legacy `runUnsplashAttributionBackfillPass` (index.ts:439-499).
 *
 * Deviation: legacy's per-row outcome has three buckets — `backfilled`,
 * `skipped` (null lookup, index.ts:464-467), and `errors` (thrown/upsert
 * failure). `EnrichmentTickSummary.attributionBackfill` (this port's Produces
 * shape) has no `skipped` field, so a null lookup is folded into `errors`
 * here — the row still gets nothing written either way, only the bucket
 * label differs from legacy.
 */
async function runAttributionBackfillPass(
  db: EnrichmentDb,
  deps: EnrichmentTickDependencies
): Promise<EnrichmentTickSummary["attributionBackfill"]> {
  const summary = { processed: 0, upserted: 0, errors: 0 }
  const unsplashAccessKey = deps.unsplashAccessKey ?? ""
  if (!unsplashAccessKey) return summary

  const lookupPhoto = deps.lookupPhoto ?? lookupUnsplashPhotoFromUrl
  const rows = await db.listEventsNeedingAttributionBackfill(deps.attributionBackfillBatch ?? 10)
  summary.processed = rows.length

  for (const row of rows) {
    try {
      const attribution = await lookupPhoto(row.imageUrl, unsplashAccessKey)
      if (!attribution) {
        // Legacy: "skipped" (index.ts:465-466) — see deviation note above.
        summary.errors += 1
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
    } catch {
      summary.errors += 1
    }
  }

  return summary
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
 */
async function runParentTipsPass(
  db: EnrichmentDb,
  deps: EnrichmentTickDependencies
): Promise<EnrichmentTickSummary["parentTips"]> {
  const summary: EnrichmentTickSummary["parentTips"] = {
    enabled: false,
    generated: 0,
    errors: 0,
  }

  const dbConfig = await db.loadParentTipsFeatureConfig()
  if (!dbConfig || !dbConfig.enabled) return summary
  summary.enabled = true

  const config = resolveParentTipsAiConfig(dbConfig, deps.parentTipsEnv)
  if (!config.configured) {
    // CONTROLLER RULING P2 — see the function-level doc comment above.
    summary.errors = 1
    return summary
  }

  const rows = await db.listEventsNeedingParentTips(deps.parentTipsBatch ?? 8)
  for (const row of rows) {
    const result = await generateParentTipsForEvent(db, row, config, {
      fetchImpl: deps.fetchImpl,
    })
    if (result.status === "generated") {
      summary.generated += 1
    } else {
      // Legacy: non-503 failure → count error, mark attempt, continue
      // (parent-tips-pass.ts:76-94).
      summary.errors += 1
      await db.markEnrichmentAttempt(row.eventId)
    }
  }

  return summary
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
 */
export async function runEnrichmentTick(
  db: EnrichmentDb,
  deps: EnrichmentTickDependencies
): Promise<EnrichmentTickSummary> {
  const now = deps.now ?? Date.now
  const startedAt = now()
  const budgetMs = deps.budgetMs ?? 110_000

  const summary: EnrichmentTickSummary = {
    claimed: 0,
    coordsSet: 0,
    imagesSet: 0,
    attemptsMarked: 0,
    errors: 0,
    tracking: { processed: 0, succeeded: 0, failed: 0 },
    attributionBackfill: { processed: 0, upserted: 0, errors: 0 },
    parentTips: { enabled: false, generated: 0, errors: 0 },
    durationMs: 0,
    stoppedEarly: false,
  }

  const candidates = await claimEnrichmentBatch(db, deps.batchSize ?? DEFAULT_ENRICHMENT_BATCH)
  summary.claimed = candidates.length

  const cityCachedDb = withCityContextCache(db)

  for (const candidate of candidates) {
    if (now() - startedAt >= budgetMs) {
      summary.stoppedEarly = true
      break
    }
    try {
      const outcome = await enrichOne(cityCachedDb, candidate, deps)
      if (outcome.coordsSet) summary.coordsSet += 1
      if (outcome.imagesSet) summary.imagesSet += 1
      if (outcome.attempted) summary.attemptsMarked += 1
    } catch {
      summary.errors += 1
    }
  }

  if (!summary.stoppedEarly) {
    summary.tracking = await runTrackingPass(db, deps)
    summary.attributionBackfill = await runAttributionBackfillPass(db, deps)
    summary.parentTips = await runParentTipsPass(db, deps)
  }

  summary.durationMs = now() - startedAt
  return summary
}
