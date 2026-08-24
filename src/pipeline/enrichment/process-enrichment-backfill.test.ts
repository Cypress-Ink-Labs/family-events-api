import { describe, expect, it, vi } from "vitest"

import { buildGeocodeQuery, type GeocodeResult } from "../geocode.js"
import type { EnvReader } from "../llm-config.js"
import type { UnsplashAttributionMetadata } from "../unsplash.js"
import type { StockImageResult } from "../stock-images.js"
import type { ParentTip, ParentTipsCandidate } from "./generate-parent-tips.js"
import {
  claimEnrichmentBatch,
  enrichOne,
  runEnrichmentTick,
  type EnrichmentCandidate,
  type EnrichmentDb,
  type EnrichmentTickDependencies,
  type ProviderImageAttributionUpsert,
  type UnsplashAttributionBackfillUpsert,
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
  | { type: "listPendingUnsplashTracking"; limit: number }
  | { type: "listEventsNeedingAttributionBackfill"; limit: number }
  | { type: "upsertUnsplashAttributionBackfill"; params: UnsplashAttributionBackfillUpsert }
  | { type: "loadParentTipsFeatureConfig" }
  | { type: "listEventsNeedingParentTips"; limit: number }
  | { type: "updateEventParentTips"; eventId: string }

class FakeEnrichmentDb implements EnrichmentDb {
  calls: CallRecord[] = []
  legacyRows: EnrichmentCandidate[] = []
  scopedRows: EnrichmentCandidate[] = []
  cityContexts = new Map<string, { name: string; state: string | null } | null>()
  nextAttributionId: string | null = "attribution-1"
  markEnrichmentAttemptError: Error | null = null
  pendingTrackingRows: Array<{
    attributionId: string
    eventId: string
    imageUrl: string
    downloadLocation: string
    attempts: number
  }> = []
  attributionBackfillRows: Array<{ eventId: string; imageUrl: string }> = []
  parentTipsFeatureConfig: {
    modelId: string | null
    provider: string | null
    enabled: boolean
  } | null = null
  parentTipsRows: ParentTipsCandidate[] = []

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

  async listPendingUnsplashTracking(limit: number): Promise<
    Array<{
      attributionId: string
      eventId: string
      imageUrl: string
      downloadLocation: string
      attempts: number
    }>
  > {
    this.calls.push({ type: "listPendingUnsplashTracking", limit })
    return this.pendingTrackingRows.slice(0, limit)
  }

  async markUnsplashTrackingResult(
    attributionId: string,
    success: boolean,
    error?: string
  ): Promise<void> {
    this.calls.push({ type: "markUnsplashTrackingResult", attributionId, success, error })
  }

  async listEventsNeedingAttributionBackfill(
    limit: number
  ): Promise<Array<{ eventId: string; imageUrl: string }>> {
    this.calls.push({ type: "listEventsNeedingAttributionBackfill", limit })
    return this.attributionBackfillRows.slice(0, limit)
  }

  async upsertUnsplashAttributionBackfill(
    params: UnsplashAttributionBackfillUpsert
  ): Promise<void> {
    this.calls.push({ type: "upsertUnsplashAttributionBackfill", params })
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
    this.calls.push({ type: "loadParentTipsFeatureConfig" })
    return this.parentTipsFeatureConfig
  }

  async listEventsNeedingParentTips(limit: number): Promise<ParentTipsCandidate[]> {
    this.calls.push({ type: "listEventsNeedingParentTips", limit })
    return this.parentTipsRows.slice(0, limit)
  }

  async updateEventParentTips(
    eventId: string,
    _tips: ParentTip[],
    _provider: string,
    _model: string,
    _promptVersion: string
  ): Promise<void> {
    this.calls.push({ type: "updateEventParentTips", eventId })
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

function parentTipsCandidate(overrides: Partial<ParentTipsCandidate> = {}): ParentTipsCandidate {
  return {
    eventId: "pt-1",
    title: "Storytime",
    description: null,
    ageMin: null,
    ageMax: null,
    isOutdoor: null,
    venueName: null,
    startDatetime: null,
    tags: [],
    ...overrides,
  }
}

function unsplashAttribution(
  overrides: Partial<UnsplashAttributionMetadata> = {}
): UnsplashAttributionMetadata {
  return {
    photoId: "photo-9",
    photographerName: "Grace Hopper",
    photographerUsername: "grace",
    photographerProfileUrl: "https://example.com/grace",
    photoUrl: "https://example.com/photo-9",
    downloadLocation: "https://api.example.com/download-9",
    ...overrides,
  }
}

// No API key configured for any provider -> resolveSharedLlmConfig's
// `configured` check fails regardless of the DB feature row.
const noopEnv: EnvReader = { get: () => undefined }

// AI_API_KEY present -> resolveSharedLlmConfig's `configured` check passes
// for an openai-provider DB row.
function openAiEnv(apiKey = "test-key"): EnvReader {
  return { get: () => apiKey }
}

function fakeFetchOk(tips: Array<{ category: string; text: string }>): typeof fetch {
  return vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ tips }) }, finish_reason: "stop" }],
          usage: {},
        }),
        { status: 200 }
      )
  ) as unknown as typeof fetch
}

function fakeFetchFail(status = 500): typeof fetch {
  return vi.fn(async () => new Response("boom", { status })) as unknown as typeof fetch
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

describe("runEnrichmentTick — city-context cache", () => {
  it("calls getCityContext at most once per cityId per tick across multiple candidates", async () => {
    const db = new FakeEnrichmentDb()
    db.cityContexts.set("city-1", { name: "Lafayette", state: "LA" })
    db.legacyRows = [
      candidate({ eventId: "a", needsCoords: true, cityId: "city-1", address: "1 A St" }),
      candidate({ eventId: "b", needsCoords: true, cityId: "city-1", address: "2 B St" }),
    ]
    const geocode = vi.fn(async () => null)

    await runEnrichmentTick(db, baseDeps({ geocode }))

    expect(db.calls.filter((c) => c.type === "getCityContext")).toHaveLength(1)
  })

  it("preserves `this = db` on every forwarded call, so a real implementation using native private class fields doesn't throw", async () => {
    // A stand-in for a repository like Task 8's, which reads state through a
    // native private field (`#`) inside a method. `Object.create(db)`
    // delegation calls forwarded methods with `this` bound to the wrapper
    // object, not `db` itself — private-field access then throws because the
    // wrapper was never constructed by this class. The Proxy-based
    // `withCityContextCache` binds every forwarded method to the real `db`
    // instance, so this must not throw.
    class PrivateFieldEnrichmentDb extends FakeEnrichmentDb {
      #marker = "private-ok"

      override async updateEventEnrichment(
        eventId: string,
        latitude: number | null,
        longitude: number | null,
        images: string[] | null
      ): Promise<void> {
        if (this.#marker !== "private-ok") throw new Error("unreachable")
        return super.updateEventEnrichment(eventId, latitude, longitude, images)
      }
    }

    const db = new PrivateFieldEnrichmentDb()
    db.legacyRows = [candidate({ eventId: "a", needsCoords: true, address: "1 A St" })]
    const geo: GeocodeResult = { latitude: 1, longitude: 2, source: "nominatim" }
    const geocode = vi.fn(async () => geo)

    const summary = await runEnrichmentTick(db, baseDeps({ geocode }))

    expect(summary.errors).toBe(0)
    expect(summary.coordsSet).toBe(1)
    expect(db.calls).toContainEqual({
      type: "updateEventEnrichment",
      eventId: "a",
      latitude: 1,
      longitude: 2,
      images: null,
    })
  })
})

describe("runEnrichmentTick — tracking pass", () => {
  it("marks success/failure per stubbed trackDownload and skips entirely when no key is configured", async () => {
    const db = new FakeEnrichmentDb()
    db.pendingTrackingRows = [
      {
        attributionId: "attr-1",
        eventId: "e1",
        imageUrl: "u1",
        downloadLocation: "https://dl-1",
        attempts: 0,
      },
      {
        attributionId: "attr-2",
        eventId: "e2",
        imageUrl: "u2",
        downloadLocation: "https://dl-2",
        attempts: 0,
      },
    ]
    const trackDownload = vi.fn(async (downloadLocation: string) => ({
      ok: downloadLocation === "https://dl-1",
      error: downloadLocation === "https://dl-1" ? null : "boom",
    }))

    const summary = await runEnrichmentTick(
      db,
      baseDeps({ unsplashAccessKey: "key", trackDownload })
    )

    expect(summary.tracking).toEqual({ processed: 2, succeeded: 1, failed: 1 })
    expect(db.calls).toContainEqual({
      type: "markUnsplashTrackingResult",
      attributionId: "attr-1",
      success: true,
      error: undefined,
    })
    expect(db.calls).toContainEqual({
      type: "markUnsplashTrackingResult",
      attributionId: "attr-2",
      success: false,
      error: "boom",
    })
  })

  it("skips the pass entirely (no list call) when no unsplash key is configured", async () => {
    const db = new FakeEnrichmentDb()
    db.pendingTrackingRows = [
      {
        attributionId: "attr-1",
        eventId: "e1",
        imageUrl: "u1",
        downloadLocation: "https://dl-1",
        attempts: 0,
      },
    ]

    const summary = await runEnrichmentTick(db, baseDeps())

    expect(summary.tracking).toEqual({ processed: 0, succeeded: 0, failed: 0 })
    expect(db.calls.some((c) => c.type === "listPendingUnsplashTracking")).toBe(false)
  })
})

describe("runEnrichmentTick — attribution backfill pass", () => {
  it("upserts from stubbed lookupPhoto and counts a null lookup as an error", async () => {
    const db = new FakeEnrichmentDb()
    db.attributionBackfillRows = [
      { eventId: "e1", imageUrl: "https://img-1" },
      { eventId: "e2", imageUrl: "https://img-2" },
    ]
    const attribution = unsplashAttribution()
    const lookupPhoto = vi.fn(async (imageUrl: string) =>
      imageUrl === "https://img-1" ? attribution : null
    )

    const summary = await runEnrichmentTick(db, baseDeps({ unsplashAccessKey: "key", lookupPhoto }))

    expect(summary.attributionBackfill).toEqual({ processed: 2, upserted: 1, errors: 1 })
    expect(db.calls).toContainEqual({
      type: "upsertUnsplashAttributionBackfill",
      params: {
        eventId: "e1",
        imageUrl: "https://img-1",
        unsplashPhotoId: attribution.photoId,
        photographerName: attribution.photographerName,
        photographerUsername: attribution.photographerUsername,
        photographerProfileUrl: attribution.photographerProfileUrl,
        photoUrl: attribution.photoUrl,
        downloadLocation: attribution.downloadLocation,
      },
    })
    expect(db.calls.filter((c) => c.type === "upsertUnsplashAttributionBackfill")).toHaveLength(1)
  })
})

describe("runEnrichmentTick — parent-tips pass", () => {
  it("reports {enabled:false} and makes zero list calls when the feature row is missing", async () => {
    const db = new FakeEnrichmentDb()
    db.parentTipsFeatureConfig = null

    const summary = await runEnrichmentTick(db, baseDeps())

    expect(summary.parentTips).toEqual({ enabled: false, generated: 0, errors: 0 })
    expect(db.calls.some((c) => c.type === "listEventsNeedingParentTips")).toBe(false)
  })

  it("reports {enabled:false} and makes zero list calls when the feature row is disabled", async () => {
    const db = new FakeEnrichmentDb()
    db.parentTipsFeatureConfig = { modelId: "gpt-4.1-nano", provider: "openai", enabled: false }

    const summary = await runEnrichmentTick(db, baseDeps())

    expect(summary.parentTips).toEqual({ enabled: false, generated: 0, errors: 0 })
    expect(db.calls.some((c) => c.type === "listEventsNeedingParentTips")).toBe(false)
  })

  it("CONTROLLER RULING P2: enabled-but-not-configured makes zero generate attempts, errors:1, generated:0", async () => {
    const db = new FakeEnrichmentDb()
    db.parentTipsFeatureConfig = { modelId: "gpt-4.1-nano", provider: "openai", enabled: true }
    db.parentTipsRows = [
      parentTipsCandidate({ eventId: "pt-1" }),
      parentTipsCandidate({ eventId: "pt-2" }),
      parentTipsCandidate({ eventId: "pt-3" }),
    ]

    const summary = await runEnrichmentTick(db, baseDeps({ parentTipsEnv: noopEnv }))

    expect(summary.parentTips).toEqual({ enabled: true, generated: 0, errors: 1 })
    expect(db.calls.some((c) => c.type === "listEventsNeedingParentTips")).toBe(false)
    expect(db.calls.some((c) => c.type === "updateEventParentTips")).toBe(false)
  })

  it("marks the attempt and continues past a per-row generation failure", async () => {
    const db = new FakeEnrichmentDb()
    db.parentTipsFeatureConfig = { modelId: "gpt-4.1-nano", provider: "openai", enabled: true }
    db.parentTipsRows = [
      parentTipsCandidate({ eventId: "pt-1" }),
      parentTipsCandidate({ eventId: "pt-2" }),
    ]

    const summary = await runEnrichmentTick(
      db,
      baseDeps({ parentTipsEnv: openAiEnv(), fetchImpl: fakeFetchFail() })
    )

    expect(summary.parentTips).toEqual({ enabled: true, generated: 0, errors: 2 })
    expect(db.calls).toContainEqual({ type: "markEnrichmentAttempt", eventId: "pt-1" })
    expect(db.calls).toContainEqual({ type: "markEnrichmentAttempt", eventId: "pt-2" })
  })

  it("logs and continues (never crashes the tick) when markEnrichmentAttempt itself fails, matching legacy parent-tips-pass.ts:76-93", async () => {
    const db = new FakeEnrichmentDb()
    db.parentTipsFeatureConfig = { modelId: "gpt-4.1-nano", provider: "openai", enabled: true }
    db.parentTipsRows = [
      parentTipsCandidate({ eventId: "pt-1" }),
      parentTipsCandidate({ eventId: "pt-2" }),
    ]
    db.markEnrichmentAttemptError = new Error("db unavailable")

    const summary = await runEnrichmentTick(
      db,
      baseDeps({ parentTipsEnv: openAiEnv(), fetchImpl: fakeFetchFail() })
    )

    // The whole tick summary must survive: both rows still counted as
    // errors, and both mark-attempt calls were still attempted (and
    // recorded) even though every one of them threw.
    expect(summary.parentTips).toEqual({ enabled: true, generated: 0, errors: 2 })
    expect(db.calls).toContainEqual({ type: "markEnrichmentAttempt", eventId: "pt-1" })
    expect(db.calls).toContainEqual({ type: "markEnrichmentAttempt", eventId: "pt-2" })
  })

  it("counts a generated tip and persists it via updateEventParentTips on success", async () => {
    const db = new FakeEnrichmentDb()
    db.parentTipsFeatureConfig = { modelId: "gpt-4.1-nano", provider: "openai", enabled: true }
    db.parentTipsRows = [parentTipsCandidate({ eventId: "pt-1" })]

    const summary = await runEnrichmentTick(
      db,
      baseDeps({
        parentTipsEnv: openAiEnv(),
        fetchImpl: fakeFetchOk([{ category: "arrival", text: "Arrive 15 minutes early." }]),
      })
    )

    expect(summary.parentTips).toEqual({ enabled: true, generated: 1, errors: 0 })
    expect(db.calls).toContainEqual({ type: "updateEventParentTips", eventId: "pt-1" })
    expect(db.calls.some((c) => c.type === "markEnrichmentAttempt")).toBe(false)
  })
})

describe("runEnrichmentTick — budget", () => {
  it("stops mid-main-batch when the budget is exhausted, skipping remaining rows and all aux passes", async () => {
    const db = new FakeEnrichmentDb()
    db.legacyRows = [
      candidate({ eventId: "a", needsCoords: true, address: "1 A St" }),
      candidate({ eventId: "b", needsCoords: true, address: "1 B St" }),
    ]
    // Aux-pass fixtures that would produce visible calls if (incorrectly) run.
    db.pendingTrackingRows = [
      {
        attributionId: "attr-1",
        eventId: "e1",
        imageUrl: "u1",
        downloadLocation: "https://dl-1",
        attempts: 0,
      },
    ]
    db.attributionBackfillRows = [{ eventId: "e1", imageUrl: "https://img-1" }]
    db.parentTipsFeatureConfig = { modelId: "gpt-4.1-nano", provider: "openai", enabled: true }

    const geocode = vi.fn(async () => ({ latitude: 1, longitude: 2, source: "nominatim" as const }))
    const clockValues = [0, 10, 150, 200]
    let clockIndex = 0
    const now = () => clockValues[Math.min(clockIndex++, clockValues.length - 1)] ?? 0

    const summary = await runEnrichmentTick(
      db,
      baseDeps({ geocode, now, budgetMs: 100, unsplashAccessKey: "key" })
    )

    expect(summary.stoppedEarly).toBe(true)
    expect(summary.claimed).toBe(2)
    expect(summary.coordsSet).toBe(1)
    expect(db.calls.some((c) => "eventId" in c && c.eventId === "b")).toBe(false)
    expect(db.calls.some((c) => c.type === "listPendingUnsplashTracking")).toBe(false)
    expect(db.calls.some((c) => c.type === "listEventsNeedingAttributionBackfill")).toBe(false)
    expect(db.calls.some((c) => c.type === "loadParentTipsFeatureConfig")).toBe(false)
    expect(summary.tracking).toEqual({ processed: 0, succeeded: 0, failed: 0 })
    expect(summary.attributionBackfill).toEqual({ processed: 0, upserted: 0, errors: 0 })
    expect(summary.parentTips).toEqual({ enabled: false, generated: 0, errors: 0 })
  })
})

describe("runEnrichmentTick — pass order", () => {
  it("runs main batch -> tracking -> attribution backfill -> parent-tips, matching legacy index.ts:501-678", async () => {
    const db = new FakeEnrichmentDb()
    db.legacyRows = [candidate({ eventId: "a", needsCoords: true, address: "1 A St" })]
    db.pendingTrackingRows = [
      {
        attributionId: "attr-1",
        eventId: "e1",
        imageUrl: "u1",
        downloadLocation: "https://dl-1",
        attempts: 0,
      },
    ]
    db.attributionBackfillRows = [{ eventId: "e1", imageUrl: "https://img-1" }]
    db.parentTipsFeatureConfig = { modelId: "gpt-4.1-nano", provider: "openai", enabled: false }
    const geocode = vi.fn(async () => null)
    const trackDownload = vi.fn(async () => ({ ok: true, error: null }))

    await runEnrichmentTick(db, baseDeps({ geocode, trackDownload, unsplashAccessKey: "key" }))

    const typeOrder = db.calls.map((c) => c.type)
    const mainBatchIndex = typeOrder.indexOf("markEnrichmentAttempt")
    const trackingIndex = typeOrder.indexOf("listPendingUnsplashTracking")
    const attributionIndex = typeOrder.indexOf("listEventsNeedingAttributionBackfill")
    const parentTipsIndex = typeOrder.indexOf("loadParentTipsFeatureConfig")

    expect(mainBatchIndex).toBeGreaterThanOrEqual(0)
    expect(trackingIndex).toBeGreaterThan(mainBatchIndex)
    expect(attributionIndex).toBeGreaterThan(trackingIndex)
    expect(parentTipsIndex).toBeGreaterThan(attributionIndex)
  })
})
