import { describe, expect, it, vi } from "vitest"

import { buildGeocodeQuery, type GeocodeResult } from "../geocode.js"
import type { StockImageResult } from "../stock-images.js"
import type { ParentTip, ParentTipsCandidate } from "./generate-parent-tips.js"
import {
  claimEnrichmentBatch,
  enrichOne,
  type EnrichmentCandidate,
  type EnrichmentDb,
  type EnrichmentTickDependencies,
  type ProviderImageAttributionUpsert,
  type UnsplashAttributionUpsert,
} from "./process-enrichment-backfill.js"

// Ported from family-events-backend supabase/functions/backfill-event-enrichment/index.ts:106-388,27,541-547 (U29).

function candidate(overrides: Partial<EnrichmentCandidate> = {}): EnrichmentCandidate {
  return {
    eventId: "event-1",
    title: "Storytime",
    description: null,
    venueName: null,
    address: null,
    cityId: null,
    sourceId: null,
    sourceUrl: null,
    needsCoords: false,
    needsImages: false,
    adminLockedFields: [],
    tags: [],
    ...overrides,
  }
}

type CallRecord =
  | { type: "listEventsNeedingEnrichment"; limit: number }
  | { type: "listImageEnrichmentInScope"; limit: number }
  | { type: "getCityContext"; cityId: string }
  | {
      type: "updateEventEnrichment"
      eventId: string
      latitude: number | null
      longitude: number | null
      images: string[] | null
    }
  | { type: "upsertUnsplashAttributionWithEnrichment"; params: UnsplashAttributionUpsert }
  | { type: "upsertProviderImageAttribution"; params: ProviderImageAttributionUpsert }
  | { type: "markUnsplashTrackingResult"; attributionId: string; success: boolean; error?: string }
  | { type: "markEnrichmentAttempt"; eventId: string }

class FakeEnrichmentDb implements EnrichmentDb {
  calls: CallRecord[] = []
  legacyRows: EnrichmentCandidate[] = []
  scopedRows: EnrichmentCandidate[] = []
  cityContexts = new Map<string, { name: string; state: string | null } | null>()
  nextAttributionId: string | null = "attribution-1"
  markEnrichmentAttemptError: Error | null = null

  async listEventsNeedingEnrichment(limit: number): Promise<EnrichmentCandidate[]> {
    this.calls.push({ type: "listEventsNeedingEnrichment", limit })
    return this.legacyRows.slice(0, limit)
  }

  async listImageEnrichmentInScope(limit: number): Promise<EnrichmentCandidate[]> {
    this.calls.push({ type: "listImageEnrichmentInScope", limit })
    return this.scopedRows.slice(0, limit)
  }

  async getCityContext(cityId: string): Promise<{ name: string; state: string | null } | null> {
    this.calls.push({ type: "getCityContext", cityId })
    return this.cityContexts.get(cityId) ?? null
  }

  async updateEventEnrichment(
    eventId: string,
    latitude: number | null,
    longitude: number | null,
    images: string[] | null
  ): Promise<void> {
    this.calls.push({ type: "updateEventEnrichment", eventId, latitude, longitude, images })
  }

  async upsertUnsplashAttributionWithEnrichment(
    params: UnsplashAttributionUpsert
  ): Promise<string | null> {
    this.calls.push({ type: "upsertUnsplashAttributionWithEnrichment", params })
    return this.nextAttributionId
  }

  async upsertProviderImageAttribution(params: ProviderImageAttributionUpsert): Promise<void> {
    this.calls.push({ type: "upsertProviderImageAttribution", params })
  }

  async listPendingUnsplashTracking(): Promise<
    Array<{
      attributionId: string
      eventId: string
      imageUrl: string
      downloadLocation: string
      attempts: number
    }>
  > {
    return []
  }

  async markUnsplashTrackingResult(
    attributionId: string,
    success: boolean,
    error?: string
  ): Promise<void> {
    this.calls.push({ type: "markUnsplashTrackingResult", attributionId, success, error })
  }

  async listEventsNeedingAttributionBackfill(): Promise<
    Array<{ eventId: string; imageUrl: string }>
  > {
    return []
  }

  async markEnrichmentAttempt(eventId: string): Promise<void> {
    this.calls.push({ type: "markEnrichmentAttempt", eventId })
    if (this.markEnrichmentAttemptError) throw this.markEnrichmentAttemptError
  }

  async loadParentTipsFeatureConfig(): Promise<{
    modelId: string | null
    provider: string | null
    enabled: boolean
  } | null> {
    return null
  }

  async listEventsNeedingParentTips(): Promise<ParentTipsCandidate[]> {
    return []
  }

  async updateEventParentTips(
    _eventId: string,
    _tips: ParentTip[],
    _provider: string,
    _model: string,
    _promptVersion: string
  ): Promise<void> {
    // no-op
  }
}

function stockResult(overrides: Partial<StockImageResult> = {}): StockImageResult {
  return {
    url: "https://images.example/photo.jpg",
    matchedTag: "storytime",
    attribution: {
      photoId: "photo-1",
      photographerName: "Ada Lovelace",
      photographerUsername: "ada",
      photographerProfileUrl: "https://example.com/ada",
      photoUrl: "https://example.com/photo",
      downloadLocation: "https://api.example.com/download",
      provider: "unsplash",
    },
    ...overrides,
  }
}

function baseDeps(overrides: Partial<EnrichmentTickDependencies> = {}): EnrichmentTickDependencies {
  return {
    providerKeys: {},
    ...overrides,
  }
}

describe("claimEnrichmentBatch", () => {
  it("splits the batch in half across both RPCs and dedupes by eventId with legacy-list winning", async () => {
    const db = new FakeEnrichmentDb()
    db.legacyRows = [candidate({ eventId: "a" }), candidate({ eventId: "b" })]
    db.scopedRows = [candidate({ eventId: "b" }), candidate({ eventId: "c" })]

    const rows = await claimEnrichmentBatch(db, 25)

    expect(db.calls).toEqual([
      { type: "listEventsNeedingEnrichment", limit: 12 },
      { type: "listImageEnrichmentInScope", limit: 12 },
    ])
    expect(rows.map((r) => r.eventId)).toEqual(["a", "b", "c"])
  })

  it("clamps halfBatch to at least 1 for a tiny batchSize", async () => {
    const db = new FakeEnrichmentDb()

    await claimEnrichmentBatch(db, 1)

    expect(db.calls).toEqual([
      { type: "listEventsNeedingEnrichment", limit: 1 },
      { type: "listImageEnrichmentInScope", limit: 1 },
    ])
  })
})

describe("enrichOne — coords", () => {
  it("writes lat/lng via updateEventEnrichment on a geocode hit, with null images", async () => {
    const db = new FakeEnrichmentDb()
    const geo: GeocodeResult = { latitude: 30.2, longitude: -92.0, source: "nominatim" }
    const geocode = vi.fn(async () => geo)

    const outcome = await enrichOne(
      db,
      candidate({ needsCoords: true, address: "123 Main St" }),
      baseDeps({ geocode })
    )

    expect(outcome).toEqual({ coordsSet: true, imagesSet: false, provider: null, attempted: false })
    expect(db.calls).toEqual([
      {
        type: "updateEventEnrichment",
        eventId: "event-1",
        latitude: 30.2,
        longitude: -92.0,
        images: null,
      },
    ])
  })

  it("falls through to markEnrichmentAttempt when geocode misses on every tier and no image is needed", async () => {
    const db = new FakeEnrichmentDb()
    const geocode = vi.fn(async () => null)

    const outcome = await enrichOne(
      db,
      candidate({ needsCoords: true, address: "123 Main St" }),
      baseDeps({ geocode })
    )

    expect(outcome).toEqual({ coordsSet: false, imagesSet: false, provider: null, attempted: true })
    expect(db.calls).toEqual([{ type: "markEnrichmentAttempt", eventId: "event-1" }])
  })

  it("tries tier1 -> tier2 (branch split on last comma) -> tier3 (venue only) in order, using getCityContext", async () => {
    const db = new FakeEnrichmentDb()
    db.cityContexts.set("city-1", { name: "Lafayette", state: "LA" })
    const geo: GeocodeResult = { latitude: 30.2, longitude: -92.0, source: "nominatim" }
    const queries: string[] = []
    const geocode = vi.fn(async (query: string) => {
      queries.push(query)
      return query === queries[2] ? geo : null
    })

    const venueName = "WRL Storytime Room, West Regional Library"
    const outcome = await enrichOne(
      db,
      candidate({ needsCoords: true, venueName, cityId: "city-1" }),
      baseDeps({ geocode })
    )

    const tier1 = buildGeocodeQuery({
      address: null,
      venueName,
      cityName: "Lafayette",
      cityState: "LA",
    })
    const tier2 = buildGeocodeQuery({
      address: null,
      venueName: "West Regional Library",
      cityName: "Lafayette",
      cityState: "LA",
    })
    const tier3 = buildGeocodeQuery({
      address: null,
      venueName,
      cityName: null,
      cityState: null,
    })

    expect(queries).toEqual([tier1, tier2, tier3])
    expect(outcome.coordsSet).toBe(true)
    expect(db.calls).toContainEqual({ type: "getCityContext", cityId: "city-1" })
  })

  it("stops at tier1 when it hits (no tier2/tier3 calls)", async () => {
    const db = new FakeEnrichmentDb()
    const geo: GeocodeResult = { latitude: 1, longitude: 2, source: "nominatim" }
    const geocode = vi.fn(async () => geo)

    await enrichOne(
      db,
      candidate({ needsCoords: true, venueName: "Solo Venue" }),
      baseDeps({ geocode })
    )

    expect(geocode).toHaveBeenCalledTimes(1)
  })
})

describe("enrichOne — images", () => {
  it("routes an unsplash findImage result through the unsplash RPC + tracking, never calling updateEventEnrichment", async () => {
    const db = new FakeEnrichmentDb()
    const result = stockResult({
      attribution: { ...stockResult().attribution, provider: "unsplash" },
    })
    const findImage = vi.fn(async () => result)
    const trackDownload = vi.fn(async () => ({ ok: true, error: null }))

    const outcome = await enrichOne(
      db,
      candidate({ needsImages: true, tags: ["storytime"] }),
      baseDeps({ providerKeys: { unsplash: "unsplash-key" }, findImage, trackDownload })
    )

    expect(outcome).toEqual({
      coordsSet: false,
      imagesSet: true,
      provider: "unsplash",
      attempted: false,
    })
    expect(db.calls[0]).toMatchObject({
      type: "upsertUnsplashAttributionWithEnrichment",
      params: expect.objectContaining({
        eventId: "event-1",
        imageUrl: result.url,
        unsplashPhotoId: result.attribution.photoId,
        photographerUsername: result.attribution.photographerUsername,
        downloadLocation: result.attribution.downloadLocation,
        matchedTag: result.matchedTag,
      }),
    })
    expect(trackDownload).toHaveBeenCalledWith(result.attribution.downloadLocation, "unsplash-key")
    expect(db.calls[1]).toEqual({
      type: "markUnsplashTrackingResult",
      attributionId: "attribution-1",
      success: true,
      error: undefined,
    })
    expect(db.calls.some((c) => c.type === "updateEventEnrichment")).toBe(false)
  })

  it("routes a pexels findImage result through updateEventEnrichment + upsertProviderImageAttribution", async () => {
    const db = new FakeEnrichmentDb()
    const result = stockResult({
      attribution: {
        photoId: "pexels-1",
        photographerName: "Grace Hopper",
        photographerProfileUrl: "https://example.com/grace",
        photoUrl: "https://example.com/pexels-photo",
        provider: "pexels",
      },
    })
    const findImage = vi.fn(async () => result)

    const outcome = await enrichOne(
      db,
      candidate({ needsImages: true, tags: ["storytime"] }),
      baseDeps({ providerKeys: { pexels: "pexels-key" }, findImage })
    )

    expect(outcome).toEqual({
      coordsSet: false,
      imagesSet: true,
      provider: "pexels",
      attempted: false,
    })
    expect(db.calls[0]).toEqual({
      type: "updateEventEnrichment",
      eventId: "event-1",
      latitude: null,
      longitude: null,
      images: [result.url],
    })
    expect(db.calls[1]).toEqual({
      type: "upsertProviderImageAttribution",
      params: {
        eventId: "event-1",
        imageUrl: result.url,
        provider: "pexels",
        matchedTag: result.matchedTag,
        pexelsPhotoId: "pexels-1",
        pexelsPhotographerName: "Grace Hopper",
        pexelsPhotographerProfileUrl: "https://example.com/grace",
        pexelsPhotoUrl: "https://example.com/pexels-photo",
        pixabayPhotoId: null,
        pixabayPhotographerName: null,
        pixabayPhotographerUsername: null,
        pixabayPhotoUrl: null,
      },
    })
  })

  it("does not call findImage and falls through to attempt-mark when tags is empty", async () => {
    const db = new FakeEnrichmentDb()
    const findImage = vi.fn(async () => null)

    const outcome = await enrichOne(
      db,
      candidate({ needsImages: true, tags: [] }),
      baseDeps({ findImage })
    )

    expect(findImage).not.toHaveBeenCalled()
    expect(outcome).toEqual({ coordsSet: false, imagesSet: false, provider: null, attempted: true })
    expect(db.calls).toEqual([{ type: "markEnrichmentAttempt", eventId: "event-1" }])
  })
})

describe("enrichOne — row-level errors", () => {
  it("propagates a thrown error for one row so a caller's loop can catch it and continue with the next row", async () => {
    const db = new FakeEnrichmentDb()
    db.markEnrichmentAttemptError = new Error("db unavailable")
    const geocode = vi.fn(async () => null)

    const candidates = [
      candidate({ eventId: "bad", needsCoords: true, address: "1 Bad St" }),
      candidate({ eventId: "good", needsCoords: true, address: "1 Good St" }),
    ]

    let errors = 0
    for (const c of candidates) {
      if (c.eventId === "good") db.markEnrichmentAttemptError = null
      try {
        await enrichOne(db, c, baseDeps({ geocode }))
      } catch {
        errors += 1
      }
    }

    expect(errors).toBe(1)
    expect(db.calls).toEqual([
      { type: "markEnrichmentAttempt", eventId: "bad" },
      { type: "markEnrichmentAttempt", eventId: "good" },
    ])
  })
})
