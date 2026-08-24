import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import type { DbService } from "../../src/db/db.service.js"
import { EnrichmentRepository } from "../../src/pipeline/enrichment/enrichment.repository.js"
import { runEnrichmentTick } from "../../src/pipeline/enrichment/process-enrichment-backfill.js"

import { createIntegrationDb } from "./db.js"
import { createEnrichmentFixtures, type EnrichmentFixtures } from "./enrichment-fixtures.js"
import { ensureIngestionSchema, truncateIngestion } from "./ingestion-catalog.js"

// U29: real-database correctness tests for EnrichmentRepository, the pg
// implementation of EnrichmentDb + EmbeddingsBackfillDb (which in turn pulls
// in ParentTipsDb and EmbedEventDb). Every method round-trips against the
// real RPCs ported into test/integration/sql/event_enrichment_rpcs.sql; the
// RPC SQL itself is already correctness-tested in
// enrichment-rpcs.integration.test.ts, so this file focuses on the
// repository's parameter marshalling and camelCase row mapping instead of
// re-proving RPC business logic.
//
// list_events_needing_embeddings (Task 2) requires the pgvector extension;
// ensureIngestionSchema already installs event_embeddings_similarity.sql
// (the table + extension), and this file layers the RPC itself on top in
// beforeAll, matching enrichment-rpcs.integration.test.ts's pattern exactly.

let db: DbService
let repo: EnrichmentRepository
let seedCity: EnrichmentFixtures["seedCity"]
let seedEvent: EnrichmentFixtures["seedEvent"]
let seedTag: EnrichmentFixtures["seedTag"]
let attachTag: EnrichmentFixtures["attachTag"]
let eventById: EnrichmentFixtures["eventById"]

beforeAll(async () => {
  db = createIntegrationDb()
  await ensureIngestionSchema(db)
  await db.query(
    readFileSync(
      join(process.cwd(), "test", "integration", "sql", "list_events_needing_embeddings.sql"),
      "utf8"
    )
  )
  repo = new EnrichmentRepository(db)
  ;({ seedCity, seedEvent, seedTag, attachTag, eventById } = createEnrichmentFixtures(db, {
    cityName: "Lafayette",
    cityState: "LA",
  }))
})

afterAll(async () => {
  await db.onModuleDestroy()
})

beforeEach(async () => {
  await truncateIngestion(db)
})

async function attributionsForEvent(eventId: string) {
  return db.query<Record<string, unknown>>(
    `SELECT * FROM public.event_image_attributions WHERE event_id = $1::uuid ORDER BY created_at`,
    [eventId]
  )
}

// ── EnrichmentDb: claim queues ───────────────────────────────────────────

describe("listEventsNeedingEnrichment / listImageEnrichmentInScope", () => {
  it("returns mapped camelCase EnrichmentCandidate rows", async () => {
    const cityId = await seedCity()
    const eventId = await seedEvent({
      city_id: cityId,
      address: "433 Jefferson St",
      latitude: null,
      longitude: null,
    })
    const tagId = await seedTag("family-fun")
    await attachTag(eventId, tagId, 0.8)

    const rows = await repo.listEventsNeedingEnrichment(25)
    const row = rows.find((r) => r.eventId === eventId)

    expect(row).toEqual({
      eventId,
      title: "Test Event",
      description: null,
      venueName: null,
      address: "433 Jefferson St",
      cityId,
      sourceId: null,
      sourceUrl: null,
      needsCoords: true,
      needsImages: true,
      adminLockedFields: [],
      tags: ["family-fun"],
    })
  })

  it("listImageEnrichmentInScope returns the scoped shape with needsCoords=false", async () => {
    const eventId = await seedEvent({ status: "published", is_featured: true })

    const rows = await repo.listImageEnrichmentInScope(25)
    const row = rows.find((r) => r.eventId === eventId)

    expect(row).toMatchObject({ eventId, needsCoords: false, needsImages: true })
  })
})

describe("getCityContext", () => {
  it("returns name/state and null for a missing city", async () => {
    const cityId = await seedCity()

    expect(await repo.getCityContext(cityId)).toEqual({ name: "Lafayette", state: "LA" })
    expect(await repo.getCityContext(randomUUID())).toBeNull()
  })
})

describe("updateEventEnrichment", () => {
  it("writes coords/images and honors admin_locked_fields", async () => {
    const eventId = await seedEvent({
      latitude: 1,
      longitude: 2,
      admin_locked_fields: ["latitude"],
    })

    await repo.updateEventEnrichment(eventId, 99, 88, ["https://example.com/img.jpg"])

    const row = await eventById(eventId)
    expect(row.latitude).toBe("1")
    expect(row.longitude).toBe("88")
    expect(row.images).toEqual(["https://example.com/img.jpg"])
  })

  it("preserves existing values when params are null", async () => {
    const eventId = await seedEvent({ latitude: 1, longitude: 2, images: ["existing.jpg"] })

    await repo.updateEventEnrichment(eventId, null, null, null)

    const row = await eventById(eventId)
    expect(row.latitude).toBe("1")
    expect(row.longitude).toBe("2")
    expect(row.images).toEqual(["existing.jpg"])
  })
})

describe("markEnrichmentAttempt", () => {
  it("bumps last_enrichment_attempt_at only", async () => {
    const eventId = await seedEvent({ latitude: 1, longitude: 2 })
    expect((await eventById(eventId)).last_enrichment_attempt_at).toBeNull()

    await repo.markEnrichmentAttempt(eventId)

    const row = await eventById(eventId)
    expect(row.last_enrichment_attempt_at).not.toBeNull()
    expect(row.latitude).toBe("1")
  })
})

// ── EnrichmentDb: unsplash write path ────────────────────────────────────

describe("upsertUnsplashAttributionWithEnrichment", () => {
  it("writes coords+images and returns the attribution id", async () => {
    const eventId = await seedEvent({ latitude: null, longitude: null })
    const imageUrl = "https://images.unsplash.com/photo-1"

    const attributionId = await repo.upsertUnsplashAttributionWithEnrichment({
      eventId,
      latitude: 30.1,
      longitude: -92.1,
      images: [imageUrl],
      imageUrl,
      unsplashPhotoId: "photo-1",
      photographerName: "Photographer",
      photographerUsername: "photog",
      photographerProfileUrl: "https://unsplash.com/@photog",
      photoUrl: imageUrl,
      downloadLocation: "https://api.unsplash.com/photos/1/download",
      matchedTag: "family-fun",
    })

    expect(attributionId).not.toBeNull()
    const event = await eventById(eventId)
    expect(event.latitude).toBe("30.1")
    expect(event.images).toEqual([imageUrl])

    const [attribution] = await attributionsForEvent(eventId)
    expect(attribution).toMatchObject({
      id: attributionId,
      provider: "unsplash",
      matched_tag: "family-fun",
      unsplash_photo_id: "photo-1",
      download_tracking_status: "pending",
    })
  })

  it("returns null when images are locked", async () => {
    const eventId = await seedEvent({ admin_locked_fields: ["images"] })
    const imageUrl = "https://images.unsplash.com/photo-1"

    const attributionId = await repo.upsertUnsplashAttributionWithEnrichment({
      eventId,
      latitude: null,
      longitude: null,
      images: [imageUrl],
      imageUrl,
      unsplashPhotoId: "photo-1",
      photographerName: "Photographer",
      photographerUsername: "photog",
      photographerProfileUrl: "https://unsplash.com/@photog",
      photoUrl: imageUrl,
      downloadLocation: "https://api.unsplash.com/photos/1/download",
      matchedTag: null,
    })

    expect(attributionId).toBeNull()
    expect(await attributionsForEvent(eventId)).toHaveLength(0)
  })
})

describe("upsertProviderImageAttribution", () => {
  it("inserts a pexels attribution row", async () => {
    const eventId = await seedEvent()
    const imageUrl = "https://images.pexels.com/photo-1"

    await repo.upsertProviderImageAttribution({
      eventId,
      imageUrl,
      provider: "pexels",
      matchedTag: "splash-park",
      pexelsPhotoId: "111",
      pexelsPhotographerName: "Jane Doe",
      pexelsPhotographerProfileUrl: "https://pexels.com/@jane",
      pexelsPhotoUrl: "https://pexels.com/photo/111",
      pixabayPhotoId: null,
      pixabayPhotographerName: null,
      pixabayPhotographerUsername: null,
      pixabayPhotoUrl: null,
    })

    const [attribution] = await attributionsForEvent(eventId)
    expect(attribution).toMatchObject({
      event_id: eventId,
      image_url: imageUrl,
      provider: "pexels",
      matched_tag: "splash-park",
      pexels_photo_id: "111",
      pexels_photographer_name: "Jane Doe",
      pexels_photographer_profile_url: "https://pexels.com/@jane",
      pexels_photo_url: "https://pexels.com/photo/111",
      pixabay_photo_id: null,
    })
  })

  it("upserts a pixabay attribution row on conflict (event_id, image_url)", async () => {
    const eventId = await seedEvent()
    const imageUrl = "https://images.pixabay.com/photo-1"

    await repo.upsertProviderImageAttribution({
      eventId,
      imageUrl,
      provider: "pixabay",
      matchedTag: "old-tag",
      pexelsPhotoId: null,
      pexelsPhotographerName: null,
      pexelsPhotographerProfileUrl: null,
      pexelsPhotoUrl: null,
      pixabayPhotoId: "222",
      pixabayPhotographerName: "John Roe",
      pixabayPhotographerUsername: "johnroe",
      pixabayPhotoUrl: "https://pixabay.com/photo/222",
    })
    await repo.upsertProviderImageAttribution({
      eventId,
      imageUrl,
      provider: "pixabay",
      matchedTag: "new-tag",
      pexelsPhotoId: null,
      pexelsPhotographerName: null,
      pexelsPhotographerProfileUrl: null,
      pexelsPhotoUrl: null,
      pixabayPhotoId: "222",
      pixabayPhotographerName: "John Roe",
      pixabayPhotographerUsername: "johnroe",
      pixabayPhotoUrl: "https://pixabay.com/photo/222",
    })

    const rows = await attributionsForEvent(eventId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ matched_tag: "new-tag" })
  })
})

// ── EnrichmentDb: unsplash download tracking ─────────────────────────────

describe("listPendingUnsplashTracking / markUnsplashTrackingResult", () => {
  it("round-trips a pending row and marks it succeeded", async () => {
    const eventId = await seedEvent()
    const imageUrl = "https://images.unsplash.com/photo-pending"
    const attributionId = await repo.upsertUnsplashAttributionWithEnrichment({
      eventId,
      latitude: null,
      longitude: null,
      images: [imageUrl],
      imageUrl,
      unsplashPhotoId: "photo-1",
      photographerName: "Photographer",
      photographerUsername: "photog",
      photographerProfileUrl: "https://unsplash.com/@photog",
      photoUrl: imageUrl,
      downloadLocation: "https://api.unsplash.com/photos/1/download",
      matchedTag: null,
    })

    const pending = await repo.listPendingUnsplashTracking(25)
    expect(pending).toEqual([
      {
        attributionId,
        eventId,
        imageUrl,
        downloadLocation: "https://api.unsplash.com/photos/1/download",
        attempts: 0,
      },
    ])

    await repo.markUnsplashTrackingResult(attributionId!, true)

    expect(await repo.listPendingUnsplashTracking(25)).toEqual([])
    const [attribution] = await attributionsForEvent(eventId)
    expect(attribution?.download_tracking_status).toBe("succeeded")
    expect(attribution?.download_tracked_at).not.toBeNull()
  })

  it("failure applies the exponential backoff and records the error", async () => {
    const eventId = await seedEvent()
    const imageUrl = "https://images.unsplash.com/photo-failing"
    const attributionId = await repo.upsertUnsplashAttributionWithEnrichment({
      eventId,
      latitude: null,
      longitude: null,
      images: [imageUrl],
      imageUrl,
      unsplashPhotoId: "photo-1",
      photographerName: "Photographer",
      photographerUsername: "photog",
      photographerProfileUrl: "https://unsplash.com/@photog",
      photoUrl: imageUrl,
      downloadLocation: "https://api.unsplash.com/photos/1/download",
      matchedTag: null,
    })

    await repo.markUnsplashTrackingResult(attributionId!, false, "boom")

    const [row] = await db.query<{
      attempts: number
      status: string
      last_error: string | null
      minutes_out: string
    }>(
      `SELECT download_tracking_attempts AS attempts, download_tracking_status AS status,
              download_tracking_last_error AS last_error,
              round(extract(epoch FROM (download_tracking_next_attempt_at - now())) / 60)::text
                AS minutes_out
       FROM public.event_image_attributions WHERE id = $1::uuid`,
      [attributionId]
    )
    expect(row?.attempts).toBe(1)
    expect(row?.status).toBe("failed")
    expect(row?.last_error).toBe("boom")
    expect(Number(row?.minutes_out)).toBeGreaterThanOrEqual(14)
    expect(Number(row?.minutes_out)).toBeLessThanOrEqual(16)
  })
})

// ── EnrichmentDb: attribution backfill ───────────────────────────────────

describe("listEventsNeedingAttributionBackfill / upsertUnsplashAttributionBackfill", () => {
  it("round-trips a claimable row and the backfill upsert marks it pending for tracking", async () => {
    const eventId = await seedEvent({
      status: "published",
      images: ["https://images.unsplash.com/photo-abc"],
    })

    const rows = await repo.listEventsNeedingAttributionBackfill(10)
    expect(rows).toContainEqual({
      eventId,
      imageUrl: "https://images.unsplash.com/photo-abc",
    })

    await repo.upsertUnsplashAttributionBackfill({
      eventId,
      imageUrl: "https://images.unsplash.com/photo-abc",
      unsplashPhotoId: "photo-abc",
      photographerName: "Photographer",
      photographerUsername: "photog",
      photographerProfileUrl: "https://unsplash.com/@photog",
      photoUrl: "https://images.unsplash.com/photo-abc",
      downloadLocation: "https://api.unsplash.com/photos/abc/download",
    })

    const [attribution] = await attributionsForEvent(eventId)
    expect(attribution).toMatchObject({
      provider: "unsplash",
      matched_tag: null,
      unsplash_photo_id: "photo-abc",
      download_tracking_status: "pending",
    })
    expect(attribution?.download_tracking_next_attempt_at).not.toBeNull()

    // Backfilled row is now claimable by the tracking pass.
    const pending = await repo.listPendingUnsplashTracking(25)
    expect(pending.map((r) => r.eventId)).toContain(eventId)

    // ...and no longer needs backfill itself.
    expect(await repo.listEventsNeedingAttributionBackfill(10)).toEqual([])
  })
})

// ── ParentTipsDb ──────────────────────────────────────────────────────────

describe("loadParentTipsFeatureConfig", () => {
  it("returns the joined row for feature='parent-tips'", async () => {
    await db.query(
      `INSERT INTO public.approved_ai_models (id, provider, display_name)
       VALUES ('gpt-5', 'openai', 'GPT-5')`
    )
    await db.query(
      `INSERT INTO public.ai_feature_config (feature, model_id, enabled)
       VALUES ('parent-tips', 'gpt-5', true)`
    )

    expect(await repo.loadParentTipsFeatureConfig()).toEqual({
      modelId: "gpt-5",
      provider: "openai",
      enabled: true,
    })
  })

  it("returns null when unconfigured", async () => {
    expect(await repo.loadParentTipsFeatureConfig()).toBeNull()
  })
})

describe("listEventsNeedingParentTips / updateEventParentTips", () => {
  it("round-trips candidates ordered by tag confidence and writes tips + provenance", async () => {
    const eventId = await seedEvent({
      status: "published",
      start_datetime: "2026-09-01T15:00:00Z",
      age_min: 3,
      age_max: 8,
      is_outdoor: true,
      venue_name: "Splash Park",
    })
    const lowTag = await seedTag("low-confidence")
    const highTag = await seedTag("high-confidence")
    await attachTag(eventId, lowTag, 0.2)
    await attachTag(eventId, highTag, 0.9)

    const rows = await repo.listEventsNeedingParentTips(10)
    const row = rows.find((r) => r.eventId === eventId)
    expect(row).toEqual({
      eventId,
      title: "Test Event",
      description: null,
      ageMin: 3,
      ageMax: 8,
      isOutdoor: true,
      venueName: "Splash Park",
      startDatetime: "2026-09-01T15:00:00.000Z",
      tags: ["high-confidence", "low-confidence"],
    })

    await repo.updateEventParentTips(
      eventId,
      [
        { category: "bring", tip: "Bring sunscreen" },
        { category: "timing", tip: "Arrive early" },
      ],
      "openai",
      "gpt-5",
      "parent-tips-v1"
    )

    const after = await eventById(eventId)
    // Legacy's ParentTipRecord wire/storage shape is { category, text }
    // (family-events-backend generate-parent-tips/handler.ts:210, 351-358) —
    // the repository maps ParentTip.tip back to `text` on write.
    expect(after.parent_tips).toEqual([
      { category: "bring", text: "Bring sunscreen" },
      { category: "timing", text: "Arrive early" },
    ])
    expect(after.parent_tips_provider).toBe("openai")
    expect(after.parent_tips_model).toBe("gpt-5")
    expect(after.parent_tips_prompt_version).toBe("parent-tips-v1")
    expect((await eventById(eventId)).last_enrichment_attempt_at).not.toBeNull()
  })
})

// ── EmbeddingsBackfillDb / EmbedEventDb ──────────────────────────────────

describe("upsertEventEmbedding / listEventsNeedingEmbeddings", () => {
  const embedding = Array.from({ length: 1536 }, (_, i) => i / 1536)

  it("upserting an embedding excludes the event from the needing-embeddings list", async () => {
    const embedded = await seedEvent({ title: "Already Embedded" })
    const unembedded = await seedEvent({ title: "Needs Embedding" })

    let ids = (await repo.listEventsNeedingEmbeddings(50)).map((r) => r.id)
    expect(ids).toContain(embedded)
    expect(ids).toContain(unembedded)

    await repo.upsertEventEmbedding(embedded, embedding, "text-embedding-3-small")

    ids = (await repo.listEventsNeedingEmbeddings(50)).map((r) => r.id)
    expect(ids).not.toContain(embedded)
    expect(ids).toContain(unembedded)

    const [row] = await db.query<{ model: string; embedding: string }>(
      `SELECT model, embedding::text AS embedding FROM public.event_embeddings WHERE event_id = $1::uuid`,
      [embedded]
    )
    expect(row?.model).toBe("text-embedding-3-small")
    expect(row?.embedding).toContain("0,")
  })

  it("upserting twice for the same event replaces the row (ON CONFLICT (event_id))", async () => {
    const eventId = await seedEvent()
    await repo.upsertEventEmbedding(eventId, embedding, "text-embedding-3-small")
    const updated = embedding.map((v) => v + 1)

    await repo.upsertEventEmbedding(eventId, updated, "text-embedding-3-small")

    const rows = await db.query<{ count: string }>(
      `SELECT count(*)::text FROM public.event_embeddings WHERE event_id = $1::uuid`,
      [eventId]
    )
    expect(rows[0]?.count).toBe("1")
  })
})

// ── Composed: one full runEnrichmentTick pass against the repository ────

describe("runEnrichmentTick against EnrichmentRepository", () => {
  it("enriches a geocodable, imageless event: writes coords + image + attribution", async () => {
    const cityId = await seedCity({ latitude: 30.0, longitude: -92.0 })
    const eventId = await seedEvent({
      city_id: cityId,
      address: "433 Jefferson St",
      latitude: null,
      longitude: null,
      images: [],
    })
    const tagId = await seedTag("splash-park")
    await attachTag(eventId, tagId, 0.9)

    const stubImageUrl = "https://images.unsplash.com/photo-composed"
    let geocodeCalls = 0
    let trackDownloadCalls = 0

    const summary = await runEnrichmentTick(repo, {
      providerKeys: { unsplash: "test-unsplash-key" },
      geocode: async () => {
        geocodeCalls += 1
        return { latitude: 30.25, longitude: -92.15, source: "nominatim" as const }
      },
      findImage: async () => ({
        url: stubImageUrl,
        matchedTag: "splash-park",
        attribution: {
          photoId: "composed-1",
          photographerName: "Composed Photographer",
          photographerUsername: "composed",
          photographerProfileUrl: "https://unsplash.com/@composed",
          photoUrl: stubImageUrl,
          downloadLocation: "https://api.unsplash.com/photos/composed-1/download",
          provider: "unsplash" as const,
        },
      }),
      trackDownload: async () => {
        trackDownloadCalls += 1
        return { ok: true, error: null }
      },
    })

    expect(geocodeCalls).toBe(1)
    expect(trackDownloadCalls).toBe(1)

    const event = await eventById(eventId)
    expect(event.latitude).toBe("30.25")
    expect(event.longitude).toBe("-92.15")
    expect(event.images).toEqual([stubImageUrl])

    const [attribution] = await attributionsForEvent(eventId)
    expect(attribution).toMatchObject({
      provider: "unsplash",
      image_url: stubImageUrl,
      matched_tag: "splash-park",
      download_tracking_status: "succeeded",
    })
    expect(attribution?.download_tracked_at).not.toBeNull()

    expect(summary).toMatchObject({
      claimed: 1,
      coordsSet: 1,
      imagesSet: 1,
      attemptsMarked: 0,
      errors: 0,
      tracking: { processed: 0, succeeded: 0, failed: 0 },
      attributionBackfill: { processed: 0, upserted: 0, skipped: 0, errors: 0 },
      parentTips: { enabled: false, generated: 0, errors: 0 },
      stoppedEarly: false,
    })
  })

  it("marks a pending attribution through the tracking pass when both Unsplash keys are supplied", async () => {
    const eventId = await seedEvent({ latitude: 30, longitude: -92, images: [] })
    const imageUrl = "https://images.unsplash.com/photo-tracking-pass"
    const attributionId = await repo.upsertUnsplashAttributionWithEnrichment({
      eventId,
      latitude: 30,
      longitude: -92,
      images: [imageUrl],
      imageUrl,
      unsplashPhotoId: "tracking-pass-1",
      photographerName: "Tracking Photographer",
      photographerUsername: "tracking",
      photographerProfileUrl: "https://unsplash.com/@tracking",
      photoUrl: imageUrl,
      downloadLocation: "https://api.unsplash.com/photos/tracking-pass-1/download",
      matchedTag: "family-fun",
    })
    expect(attributionId).not.toBeNull()

    const summary = await runEnrichmentTick(repo, {
      providerKeys: { unsplash: "test-unsplash-key" },
      unsplashAccessKey: "test-unsplash-key",
      trackDownload: async () => ({ ok: true, error: null }),
    })

    expect(summary.tracking).toEqual({ processed: 1, succeeded: 1, failed: 0 })
    const [attribution] = await attributionsForEvent(eventId)
    expect(attribution).toMatchObject({
      id: attributionId,
      download_tracking_status: "succeeded",
    })
    expect(attribution?.download_tracked_at).not.toBeNull()
  })
})
