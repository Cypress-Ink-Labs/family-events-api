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
import type { ParentTipsDb } from "./generate-parent-tips.js"

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
}

/**
 * Dependencies shared by `enrichOne`/`claimEnrichmentBatch` (Task 6) and
 * `runEnrichmentTick`'s auxiliary passes (Task 7). Every network helper is
 * injectable and defaults to the real module function so production callers
 * only need to supply provider keys and env.
 */
export interface EnrichmentTickDependencies {
  providerKeys: StockImageProviderKeys
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
