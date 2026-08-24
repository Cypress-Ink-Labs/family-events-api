import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import type { DbService } from "../../src/db/db.service.js"

import { createIntegrationDb } from "./db.js"
import { ensureIngestionSchema, truncateIngestion } from "./ingestion-catalog.js"

// U29: the enrichment RPCs (geocode/image claim queues, coordinate + image
// writes, Unsplash download-tracking, attribution backfill, parent-tips
// claim + write) — REAL SQL extracted verbatim from the backend migrations
// (test/integration/sql/event_enrichment_rpcs.sql). This file is a
// correctness smoke test of the SQL itself; the repository arrives in a
// later task.
//
// list_events_needing_embeddings (Task 2) LEFT JOINs public.event_embeddings,
// which requires the pgvector extension. ensureIngestionSchema already
// installs that table/extension via event_embeddings_similarity.sql, but the
// new RPC itself stays out of the shared base schema and is layered on here
// instead (test/integration/sql/list_events_needing_embeddings.sql).

let db: DbService

beforeAll(async () => {
  db = createIntegrationDb()
  await ensureIngestionSchema(db)
  await db.query(
    readFileSync(
      join(process.cwd(), "test", "integration", "sql", "list_events_needing_embeddings.sql"),
      "utf8"
    )
  )
})

afterAll(async () => {
  await db.onModuleDestroy()
})

beforeEach(async () => {
  await truncateIngestion(db)
})

async function seedCity(
  overrides: Partial<{ id: string; latitude: number | null; longitude: number | null }> = {}
): Promise<string> {
  const id = overrides.id ?? randomUUID()
  const slug = `test-city-${id.slice(0, 8)}`
  await db.query(
    `INSERT INTO public.cities (id, name, state, slug, timezone, latitude, longitude)
     VALUES ($1, 'Test City', 'TX', $2, 'America/Chicago', $3, $4)`,
    [id, slug, overrides.latitude ?? null, overrides.longitude ?? null]
  )
  return id
}

async function seedEvent(
  overrides: Partial<{
    id: string
    city_id: string
    status: string
    title: string
    description: string | null
    venue_name: string | null
    address: string | null
    latitude: number | null
    longitude: number | null
    images: string[]
    admin_locked_fields: string[]
    is_featured: boolean
    start_datetime: string
    last_enrichment_attempt_at: string | null
    llm_review_decision: string | null
    parent_tips: object | null
    age_min: number | null
    age_max: number | null
    is_outdoor: boolean | null
    created_at: string | null
  }> = {}
): Promise<string> {
  const cityId = overrides.city_id ?? (await seedCity())
  const eventId = overrides.id ?? randomUUID()
  await db.query(
    `INSERT INTO public.events
       (id, city_id, title, description, venue_name, address, start_datetime,
        status, latitude, longitude, images, admin_locked_fields, is_featured,
        last_enrichment_attempt_at, llm_review_decision, parent_tips, age_min, age_max, is_outdoor,
        created_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, COALESCE($7::timestamptz, now()),
             $8::public.event_status, $9, $10, COALESCE($11::jsonb, '[]'::jsonb), COALESCE($12::text[], '{}'::text[]), $13,
             $14::timestamptz, $15::public.llm_event_review_decision, $16::jsonb, $17, $18, $19,
             COALESCE($20::timestamptz, now()))`,
    [
      eventId,
      cityId,
      overrides.title ?? "Test Event",
      overrides.description ?? null,
      overrides.venue_name ?? null,
      overrides.address === undefined ? "123 Main St" : overrides.address,
      overrides.start_datetime ?? null,
      overrides.status ?? "draft",
      overrides.latitude ?? null,
      overrides.longitude ?? null,
      overrides.images ? JSON.stringify(overrides.images) : null,
      overrides.admin_locked_fields ?? null,
      overrides.is_featured ?? false,
      overrides.last_enrichment_attempt_at ?? null,
      overrides.llm_review_decision ?? null,
      overrides.parent_tips ? JSON.stringify(overrides.parent_tips) : null,
      overrides.age_min ?? null,
      overrides.age_max ?? null,
      overrides.is_outdoor ?? null,
      overrides.created_at ?? null,
    ]
  )
  return eventId
}

async function seedEmbedding(eventId: string, embedding: string): Promise<void> {
  await db.query(
    `INSERT INTO public.event_embeddings (event_id, embedding)
     VALUES ($1::uuid, $2::extensions.vector)`,
    [eventId, embedding]
  )
}

async function seedTag(slug: string = `tag-${randomUUID().slice(0, 8)}`): Promise<string> {
  const id = randomUUID()
  await db.query(`INSERT INTO public.tags (id, name, slug) VALUES ($1::uuid, $2, $2)`, [id, slug])
  return id
}

async function attachTag(eventId: string, tagId: string, confidence: number): Promise<void> {
  await db.query(
    `INSERT INTO public.event_tags (event_id, tag_id, confidence) VALUES ($1::uuid, $2::uuid, $3)`,
    [eventId, tagId, confidence]
  )
}

async function eventById(id: string) {
  const rows = await db.query<{
    latitude: string | null
    longitude: string | null
    images: unknown[]
    updated_at: string
    last_enrichment_attempt_at: string | null
    parent_tips: unknown
    parent_tips_generated_at: string | null
    parent_tips_provider: string | null
    parent_tips_model: string | null
    parent_tips_prompt_version: string | null
  }>(
    `SELECT latitude::text, longitude::text, images, updated_at, last_enrichment_attempt_at,
            parent_tips, parent_tips_generated_at, parent_tips_provider, parent_tips_model,
            parent_tips_prompt_version
     FROM public.events WHERE id = $1::uuid`,
    [id]
  )
  return rows[0]!
}

async function insertAttribution(overrides: {
  event_id: string
  image_url?: string
  download_tracking_status?: string
  download_tracked_at?: string | null
  download_tracking_attempts?: number
  download_tracking_next_attempt_at?: string
}): Promise<string> {
  const id = randomUUID()
  await db.query(
    `INSERT INTO public.event_image_attributions
       (id, event_id, image_url, provider, unsplash_photo_id, unsplash_photographer_name,
        unsplash_photographer_username, unsplash_photographer_profile_url, unsplash_photo_url,
        unsplash_download_location, download_tracking_status, download_tracked_at,
        download_tracking_attempts, download_tracking_next_attempt_at)
     VALUES ($1::uuid, $2::uuid, $3, 'unsplash', 'photo-1', 'Photographer', 'photog',
             'https://unsplash.com/@photog', $3, 'https://api.unsplash.com/photos/1/download',
             COALESCE($4, 'pending'), $5::timestamptz, COALESCE($6, 0),
             COALESCE($7::timestamptz, now()))`,
    [
      id,
      overrides.event_id,
      overrides.image_url ?? "https://images.unsplash.com/photo-1",
      overrides.download_tracking_status ?? null,
      overrides.download_tracked_at ?? null,
      overrides.download_tracking_attempts ?? null,
      overrides.download_tracking_next_attempt_at ?? null,
    ]
  )
  return id
}

// ── RPC call helpers ─────────────────────────────────────────────────────

interface EnrichmentCandidateRow {
  event_id: string
  needs_coords: boolean
  needs_images: boolean
  admin_locked_fields: string[]
}

async function listNeedingEnrichment(limit = 25): Promise<EnrichmentCandidateRow[]> {
  return db.query<EnrichmentCandidateRow>(
    "SELECT * FROM public.list_events_needing_enrichment($1::int)",
    [limit]
  )
}

async function backfillImageEnrichmentInScope(limit = 25): Promise<EnrichmentCandidateRow[]> {
  return db.query<EnrichmentCandidateRow>(
    "SELECT * FROM public.backfill_image_enrichment_in_scope($1::int)",
    [limit]
  )
}

async function updateEventEnrichment(params: {
  event_id: string
  latitude: number | null
  longitude: number | null
  images: string[] | null
}): Promise<void> {
  await db.query("SELECT public.update_event_enrichment($1::uuid, $2, $3, $4::jsonb)", [
    params.event_id,
    params.latitude,
    params.longitude,
    params.images === null ? null : JSON.stringify(params.images),
  ])
}

async function markEventEnrichmentAttempt(eventId: string): Promise<void> {
  await db.query("SELECT public.mark_event_enrichment_attempt($1::uuid)", [eventId])
}

async function upsertAttributionWithEnrichment(params: {
  event_id: string
  latitude: number | null
  longitude: number | null
  images: string[] | null
  image_url: string | null
  unsplash_photo_id?: string
  unsplash_photographer_name?: string
  unsplash_photographer_username?: string
  unsplash_photographer_profile_url?: string
  unsplash_photo_url?: string
  unsplash_download_location?: string
  matched_tag?: string | null
}): Promise<string | null> {
  const rows = await db.query<{ attribution_id: string | null }>(
    `SELECT public.upsert_event_image_attribution_with_enrichment(
       $1::uuid, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12
     ) AS attribution_id`,
    [
      params.event_id,
      params.latitude,
      params.longitude,
      params.images === null ? null : JSON.stringify(params.images),
      params.image_url,
      params.unsplash_photo_id ?? "photo-1",
      params.unsplash_photographer_name ?? "Photographer",
      params.unsplash_photographer_username ?? "photog",
      params.unsplash_photographer_profile_url ?? "https://unsplash.com/@photog",
      params.unsplash_photo_url ?? params.image_url,
      params.unsplash_download_location ?? "https://api.unsplash.com/photos/1/download",
      params.matched_tag ?? null,
    ]
  )
  return rows[0]!.attribution_id
}

interface PendingTrackingRow {
  attribution_id: string
  event_id: string
  image_url: string
  download_location: string
  attempts: number
}

async function listPendingUnsplashDownloadTracking(limit = 25): Promise<PendingTrackingRow[]> {
  return db.query<PendingTrackingRow>(
    "SELECT * FROM public.list_pending_unsplash_download_tracking($1::int)",
    [limit]
  )
}

async function markUnsplashDownloadTrackingResult(
  attributionId: string,
  success: boolean,
  error?: string | null
): Promise<void> {
  await db.query("SELECT public.mark_unsplash_download_tracking_result($1::uuid, $2, $3)", [
    attributionId,
    success,
    error ?? null,
  ])
}

async function attributionById(id: string) {
  const rows = await db.query<{
    download_tracking_status: string
    download_tracked_at: string | null
    download_tracking_attempts: number
    download_tracking_next_attempt_at: string
    download_tracking_last_error: string | null
  }>(
    `SELECT download_tracking_status, download_tracked_at, download_tracking_attempts,
            download_tracking_next_attempt_at, download_tracking_last_error
     FROM public.event_image_attributions WHERE id = $1::uuid`,
    [id]
  )
  return rows[0]!
}

interface AttributionBackfillRow {
  event_id: string
  image_url: string
}

async function listNeedingAttributionBackfill(limit = 10): Promise<AttributionBackfillRow[]> {
  return db.query<AttributionBackfillRow>(
    "SELECT * FROM public.list_events_needing_attribution_backfill($1::int)",
    [limit]
  )
}

interface ParentTipsCandidateRow {
  event_id: string
  tags: string[]
}

async function listNeedingParentTips(limit = 10): Promise<ParentTipsCandidateRow[]> {
  return db.query<ParentTipsCandidateRow>(
    "SELECT * FROM public.list_events_needing_parent_tips($1::int)",
    [limit]
  )
}

interface EmbeddingCandidateRow {
  id: string
  title: string
  description: string | null
}

async function listNeedingEmbeddings(limit = 50): Promise<EmbeddingCandidateRow[]> {
  return db.query<EmbeddingCandidateRow>(
    "SELECT * FROM public.list_events_needing_embeddings($1::int)",
    [limit]
  )
}

async function updateEventParentTips(params: {
  event_id: string
  tips: object
  provider: string
  model: string
  prompt_version: string
}): Promise<void> {
  await db.query("SELECT public.update_event_parent_tips($1::uuid, $2::jsonb, $3, $4, $5)", [
    params.event_id,
    JSON.stringify(params.tips),
    params.provider,
    params.model,
    params.prompt_version,
  ])
}

// ── list_events_needing_enrichment ───────────────────────────────────────

describe("list_events_needing_enrichment (real SQL)", () => {
  it("returns event with NULL coords + geocodable address, needs_coords=true", async () => {
    const eventId = await seedEvent({
      address: "433 Jefferson St",
      latitude: null,
      longitude: null,
    })

    const rows = await listNeedingEnrichment()
    expect(rows.map((r) => r.event_id)).toContain(eventId)
    expect(rows.find((r) => r.event_id === eventId)?.needs_coords).toBe(true)
  })

  it("excludes an event whose address/venue has no geocodable pattern", async () => {
    const eventId = await seedEvent({
      address: "Room 204",
      venue_name: null,
      latitude: null,
      longitude: null,
      images: ["https://example.com/img.jpg"],
    })

    const rows = await listNeedingEnrichment()
    expect(rows.map((r) => r.event_id)).not.toContain(eventId)
  })

  it("treats city-centroid-equal coords as needing coords", async () => {
    const cityId = await seedCity({ latitude: 30.2241, longitude: -92.0198 })
    const eventId = await seedEvent({
      city_id: cityId,
      address: "433 Jefferson St",
      latitude: 30.2241,
      longitude: -92.0198,
      images: ["https://example.com/img.jpg"],
    })

    const rows = await listNeedingEnrichment()
    expect(rows.find((r) => r.event_id === eventId)?.needs_coords).toBe(true)
  })

  it("respects admin_locked_fields for latitude/longitude", async () => {
    const eventId = await seedEvent({
      address: "433 Jefferson St",
      latitude: null,
      longitude: null,
      admin_locked_fields: ["latitude", "longitude"],
    })

    const rows = await listNeedingEnrichment()
    const row = rows.find((r) => r.event_id === eventId)
    expect(row?.needs_coords).toBe(false)
    // still surfaces for the images claim since images isn't locked
    expect(row?.needs_images).toBe(true)
  })

  it("respects admin_locked_fields for images", async () => {
    const eventId = await seedEvent({
      address: "Room 204",
      latitude: 30.0,
      longitude: -92.0,
      admin_locked_fields: ["images"],
    })

    const rows = await listNeedingEnrichment()
    expect(rows.map((r) => r.event_id)).not.toContain(eventId)
  })

  it("orders by last_enrichment_attempt_at ASC NULLS FIRST", async () => {
    const withOldAttempt = await seedEvent({
      address: "433 Jefferson St",
      last_enrichment_attempt_at: "2026-01-01T00:00:00Z",
    })
    const withNewAttempt = await seedEvent({
      address: "433 Jefferson St",
      last_enrichment_attempt_at: "2026-06-01T00:00:00Z",
    })
    const neverAttempted = await seedEvent({ address: "433 Jefferson St" })

    const rows = await listNeedingEnrichment()
    const ids = rows.map((r) => r.event_id)
    expect(ids.indexOf(neverAttempted)).toBeLessThan(ids.indexOf(withOldAttempt))
    expect(ids.indexOf(withOldAttempt)).toBeLessThan(ids.indexOf(withNewAttempt))
  })
})

// ── backfill_image_enrichment_in_scope ───────────────────────────────────

describe("backfill_image_enrichment_in_scope (real SQL)", () => {
  it("includes published + is_featured + empty images, with needs_coords always false", async () => {
    const eventId = await seedEvent({
      status: "published",
      is_featured: true,
      latitude: null,
      longitude: null,
    })

    const rows = await backfillImageEnrichmentInScope()
    const row = rows.find((r) => r.event_id === eventId)
    expect(row).toBeDefined()
    expect(row?.needs_coords).toBe(false)
  })

  it("includes published + starts within 30 days + empty images", async () => {
    const eventId = await seedEvent({
      status: "published",
      is_featured: false,
      start_datetime: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
    })

    const rows = await backfillImageEnrichmentInScope()
    expect(rows.map((r) => r.event_id)).toContain(eventId)
  })

  it("excludes published events starting beyond 30 days and not featured", async () => {
    const eventId = await seedEvent({
      status: "published",
      is_featured: false,
      start_datetime: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
    })

    const rows = await backfillImageEnrichmentInScope()
    expect(rows.map((r) => r.event_id)).not.toContain(eventId)
  })

  it("excludes non-published events", async () => {
    const eventId = await seedEvent({ status: "draft", is_featured: true })

    const rows = await backfillImageEnrichmentInScope()
    expect(rows.map((r) => r.event_id)).not.toContain(eventId)
  })

  it("excludes events that already have images", async () => {
    const eventId = await seedEvent({
      status: "published",
      is_featured: true,
      images: ["https://example.com/img.jpg"],
    })

    const rows = await backfillImageEnrichmentInScope()
    expect(rows.map((r) => r.event_id)).not.toContain(eventId)
  })
})

// ── update_event_enrichment ──────────────────────────────────────────────

describe("update_event_enrichment (real SQL)", () => {
  it("skips locked fields", async () => {
    const eventId = await seedEvent({
      latitude: 1,
      longitude: 2,
      admin_locked_fields: ["latitude"],
    })

    await updateEventEnrichment({
      event_id: eventId,
      latitude: 99,
      longitude: 88,
      images: ["https://example.com/img.jpg"],
    })

    const row = await eventById(eventId)
    expect(row.latitude).toBe("1")
    expect(row.longitude).toBe("88")
  })

  it("preserves existing values when params are NULL", async () => {
    const eventId = await seedEvent({ latitude: 1, longitude: 2, images: ["existing.jpg"] })

    await updateEventEnrichment({
      event_id: eventId,
      latitude: null,
      longitude: null,
      images: null,
    })

    const row = await eventById(eventId)
    expect(row.latitude).toBe("1")
    expect(row.longitude).toBe("2")
    expect(row.images).toEqual(["existing.jpg"])
  })

  it("preserves existing images when the new array is empty", async () => {
    const eventId = await seedEvent({ images: ["existing.jpg"] })

    await updateEventEnrichment({ event_id: eventId, latitude: null, longitude: null, images: [] })

    const row = await eventById(eventId)
    expect(row.images).toEqual(["existing.jpg"])
  })

  it("bumps last_enrichment_attempt_at and updated_at", async () => {
    const eventId = await seedEvent()
    const before = await eventById(eventId)
    expect(before.last_enrichment_attempt_at).toBeNull()

    await updateEventEnrichment({ event_id: eventId, latitude: 1, longitude: 2, images: null })

    const after = await eventById(eventId)
    expect(after.last_enrichment_attempt_at).not.toBeNull()
  })
})

// ── mark_event_enrichment_attempt ────────────────────────────────────────

describe("mark_event_enrichment_attempt (real SQL)", () => {
  it("bumps last_enrichment_attempt_at only", async () => {
    const eventId = await seedEvent({ latitude: 1, longitude: 2, images: ["existing.jpg"] })

    await markEventEnrichmentAttempt(eventId)

    const row = await eventById(eventId)
    expect(row.last_enrichment_attempt_at).not.toBeNull()
    expect(row.latitude).toBe("1")
    expect(row.longitude).toBe("2")
    expect(row.images).toEqual(["existing.jpg"])
  })
})

// ── upsert_event_image_attribution_with_enrichment ───────────────────────

describe("upsert_event_image_attribution_with_enrichment (real SQL)", () => {
  it("writes coords+images then inserts a pending attribution row", async () => {
    const eventId = await seedEvent({ latitude: null, longitude: null })
    const imageUrl = "https://images.unsplash.com/photo-1"

    const attributionId = await upsertAttributionWithEnrichment({
      event_id: eventId,
      latitude: 30.1,
      longitude: -92.1,
      images: [imageUrl],
      image_url: imageUrl,
    })

    expect(attributionId).not.toBeNull()
    const event = await eventById(eventId)
    expect(event.latitude).toBe("30.1")
    expect(event.images).toEqual([imageUrl])

    const attribution = await attributionById(attributionId!)
    expect(attribution.download_tracking_status).toBe("pending")
  })

  it("returns NULL and skips attribution when images are locked", async () => {
    const eventId = await seedEvent({ admin_locked_fields: ["images"] })
    const imageUrl = "https://images.unsplash.com/photo-1"

    const attributionId = await upsertAttributionWithEnrichment({
      event_id: eventId,
      latitude: null,
      longitude: null,
      images: [imageUrl],
      image_url: imageUrl,
    })

    expect(attributionId).toBeNull()
    const [row] = await db.query<{ count: string }>(
      "SELECT count(*)::text FROM public.event_image_attributions WHERE event_id = $1::uuid",
      [eventId]
    )
    expect(row?.count).toBe("0")
  })

  it("returns NULL when image_url is not in the images array", async () => {
    const eventId = await seedEvent()

    const attributionId = await upsertAttributionWithEnrichment({
      event_id: eventId,
      latitude: null,
      longitude: null,
      images: ["https://images.unsplash.com/photo-1"],
      image_url: "https://images.unsplash.com/photo-OTHER",
    })

    expect(attributionId).toBeNull()
  })

  it("raises P0002 for a missing event", async () => {
    const imageUrl = "https://images.unsplash.com/photo-1"
    await expect(
      upsertAttributionWithEnrichment({
        event_id: randomUUID(),
        latitude: null,
        longitude: null,
        images: [imageUrl],
        image_url: imageUrl,
      })
    ).rejects.toMatchObject({ code: "P0002" })
  })

  it("preserves download_tracking_status on conflict once download_tracked_at is set", async () => {
    const eventId = await seedEvent()
    const imageUrl = "https://images.unsplash.com/photo-1"

    const attributionId = await upsertAttributionWithEnrichment({
      event_id: eventId,
      latitude: null,
      longitude: null,
      images: [imageUrl],
      image_url: imageUrl,
    })
    await markUnsplashDownloadTrackingResult(attributionId!, true)

    const secondId = await upsertAttributionWithEnrichment({
      event_id: eventId,
      latitude: null,
      longitude: null,
      images: [imageUrl],
      image_url: imageUrl,
      matched_tag: "updated-tag",
    })

    expect(secondId).toBe(attributionId)
    const attribution = await attributionById(attributionId!)
    expect(attribution.download_tracking_status).toBe("succeeded")
    expect(attribution.download_tracked_at).not.toBeNull()
  })
})

// ── list_pending_unsplash_download_tracking / mark_unsplash_download_tracking_result ──

describe("list_pending_unsplash_download_tracking + mark_unsplash_download_tracking_result (real SQL)", () => {
  it("lists only untracked pending/failed rows whose next_attempt_at is due", async () => {
    const eventId = await seedEvent()
    const pendingId = await insertAttribution({
      event_id: eventId,
      image_url: "https://images.unsplash.com/photo-pending",
    })
    await insertAttribution({
      event_id: eventId,
      image_url: "https://images.unsplash.com/photo-tracked",
      download_tracking_status: "succeeded",
      download_tracked_at: new Date().toISOString(),
    })

    const rows = await listPendingUnsplashDownloadTracking()
    expect(rows.map((r) => r.attribution_id)).toEqual([pendingId])
  })

  it("succeeded result sets download_tracked_at", async () => {
    const eventId = await seedEvent()
    const attributionId = await insertAttribution({ event_id: eventId })

    await markUnsplashDownloadTrackingResult(attributionId, true)

    const row = await attributionById(attributionId)
    expect(row.download_tracking_status).toBe("succeeded")
    expect(row.download_tracked_at).not.toBeNull()
  })

  it("failure increments attempts and backs off per LEAST(1440, GREATEST(5, (attempts+1)*15)) minutes", async () => {
    const eventId = await seedEvent()
    const attributionId = await insertAttribution({
      event_id: eventId,
      download_tracking_attempts: 0,
    })

    await markUnsplashDownloadTrackingResult(attributionId, false, "boom")

    const [row] = await db.query<{
      attempts: number
      minutes_out: string
      last_error: string | null
      status: string
    }>(
      `SELECT download_tracking_attempts AS attempts,
              round(extract(epoch FROM (download_tracking_next_attempt_at - now())) / 60)::text AS minutes_out,
              download_tracking_last_error AS last_error,
              download_tracking_status AS status
       FROM public.event_image_attributions WHERE id = $1::uuid`,
      [attributionId]
    )
    expect(row?.attempts).toBe(1)
    expect(row?.status).toBe("failed")
    expect(row?.last_error).toBe("boom")
    expect(Number(row?.minutes_out)).toBeGreaterThanOrEqual(14)
    expect(Number(row?.minutes_out)).toBeLessThanOrEqual(16)
  })

  it("raises P0002 for a missing attribution id", async () => {
    await expect(markUnsplashDownloadTrackingResult(randomUUID(), true)).rejects.toMatchObject({
      code: "P0002",
    })
  })
})

// ── list_events_needing_attribution_backfill ─────────────────────────────

describe("list_events_needing_attribution_backfill (real SQL)", () => {
  it("returns published events whose first image is an unattributed Unsplash CDN URL", async () => {
    const eventId = await seedEvent({
      status: "published",
      images: ["https://images.unsplash.com/photo-abc"],
    })

    const rows = await listNeedingAttributionBackfill()
    expect(rows.map((r) => r.event_id)).toContain(eventId)
  })

  it("excludes events whose first image is not an Unsplash CDN URL", async () => {
    const eventId = await seedEvent({
      status: "published",
      images: ["https://images.pexels.com/photo-abc"],
    })

    const rows = await listNeedingAttributionBackfill()
    expect(rows.map((r) => r.event_id)).not.toContain(eventId)
  })

  it("excludes events that already have an attribution row", async () => {
    const eventId = await seedEvent({
      status: "published",
      images: ["https://images.unsplash.com/photo-abc"],
    })
    await insertAttribution({
      event_id: eventId,
      image_url: "https://images.unsplash.com/photo-abc",
    })

    const rows = await listNeedingAttributionBackfill()
    expect(rows.map((r) => r.event_id)).not.toContain(eventId)
  })

  it("excludes non-published events", async () => {
    const eventId = await seedEvent({
      status: "draft",
      images: ["https://images.unsplash.com/photo-abc"],
    })

    const rows = await listNeedingAttributionBackfill()
    expect(rows.map((r) => r.event_id)).not.toContain(eventId)
  })
})

// ── list_events_needing_parent_tips ──────────────────────────────────────

describe("list_events_needing_parent_tips (real SQL)", () => {
  it("requires parent_tips IS NULL, status='published', and decision NULL-or-approve", async () => {
    const eligibleNullDecision = await seedEvent({ status: "published" })
    const eligibleApproved = await seedEvent({
      status: "published",
      llm_review_decision: "approve",
    })
    const hasTips = await seedEvent({ status: "published", parent_tips: { tips: ["a"] } })
    const notPublished = await seedEvent({ status: "draft" })
    const rejected = await seedEvent({
      status: "published",
      llm_review_decision: "needs_admin_review",
    })

    const rows = await listNeedingParentTips()
    const ids = rows.map((r) => r.event_id)
    expect(ids).toContain(eligibleNullDecision)
    expect(ids).toContain(eligibleApproved)
    expect(ids).not.toContain(hasTips)
    expect(ids).not.toContain(notPublished)
    expect(ids).not.toContain(rejected)
  })

  it("returns tags ordered by confidence descending", async () => {
    const eventId = await seedEvent({ status: "published" })
    const lowTag = await seedTag("low-confidence")
    const highTag = await seedTag("high-confidence")
    await attachTag(eventId, lowTag, 0.2)
    await attachTag(eventId, highTag, 0.9)

    const rows = await listNeedingParentTips()
    const row = rows.find((r) => r.event_id === eventId)
    expect(row?.tags).toEqual(["high-confidence", "low-confidence"])
  })
})

// ── update_event_parent_tips ─────────────────────────────────────────────

describe("update_event_parent_tips (real SQL)", () => {
  it("writes all five fields and bumps last_enrichment_attempt_at", async () => {
    const eventId = await seedEvent()

    await updateEventParentTips({
      event_id: eventId,
      tips: { tips: ["Bring sunscreen"] },
      provider: "openai",
      model: "gpt-5",
      prompt_version: "v1",
    })

    const row = await eventById(eventId)
    expect(row.parent_tips).toEqual({ tips: ["Bring sunscreen"] })
    expect(row.parent_tips_generated_at).not.toBeNull()
    expect(row.parent_tips_provider).toBe("openai")
    expect(row.parent_tips_model).toBe("gpt-5")
    expect(row.parent_tips_prompt_version).toBe("v1")
    expect(row.last_enrichment_attempt_at).not.toBeNull()
  })
})

// ── list_events_needing_embeddings ───────────────────────────────────────

describe("list_events_needing_embeddings (real SQL)", () => {
  // Content is irrelevant to this RPC (it only checks for row presence via
  // the LEFT JOIN), so a zero vector is fine.
  const ZERO_EMBEDDING = `[${Array<number>(1536).fill(0).join(",")}]`

  it("excludes events that already have an embedding row", async () => {
    const embedded = await seedEvent({ title: "Already Embedded" })
    await seedEmbedding(embedded, ZERO_EMBEDDING)
    const unembedded = await seedEvent({ title: "Needs Embedding" })

    const rows = await listNeedingEmbeddings()
    const ids = rows.map((r) => r.id)
    expect(ids).toContain(unembedded)
    expect(ids).not.toContain(embedded)
  })

  it("orders candidates by created_at ascending", async () => {
    const newer = await seedEvent({
      title: "Newer",
      created_at: "2026-06-05T00:00:00Z",
    })
    const older = await seedEvent({
      title: "Older",
      created_at: "2026-06-01T00:00:00Z",
    })

    const rows = await listNeedingEmbeddings()
    const ids = rows.map((r) => r.id)
    expect(ids.indexOf(older)).toBeLessThan(ids.indexOf(newer))
  })

  it("clamps p_limit up to 1 when given a non-positive limit", async () => {
    await seedEvent({ title: "First candidate", created_at: "2026-06-01T00:00:00Z" })
    await seedEvent({ title: "Second candidate", created_at: "2026-06-02T00:00:00Z" })

    const rows = await listNeedingEmbeddings(0)
    expect(rows).toHaveLength(1)
  })
})
