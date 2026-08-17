import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { IngestionRepository } from "../../src/pipeline/ingestion/ingestion.repository.js"
import { importParsedSourceEvents } from "../../src/pipeline/ingestion/process-source.js"
import type { ParsedEvent } from "../../src/pipeline/ingestion/types.js"
import type { EventSourceRow } from "../../src/pipeline/ingestion/types.js"
import type { DbService } from "../../src/db/db.service.js"

import { createIntegrationDb } from "./db.js"
import { ensureIngestionSchema, truncateIngestion } from "./ingestion-catalog.js"

// U28 slice C: the import path against real Postgres — the REAL
// bulk_import_scrape_events and find_cross_source_event_candidates SQL
// (extracted verbatim from the backend migrations), the IngestionRepository
// SQL, and importParsedSourceEvents end to end.

const CITY_ID = "11111111-1111-4111-8111-111111111111"

let db: DbService
let repository: IngestionRepository

beforeAll(async () => {
  db = createIntegrationDb()
  repository = new IngestionRepository(db)
  await ensureIngestionSchema(db)
})

afterAll(async () => {
  await db.onModuleDestroy()
})

beforeEach(async () => {
  await truncateIngestion(db)
  await db.query(
    `INSERT INTO public.cities (id, name, slug, timezone, latitude, longitude)
     VALUES ($1::uuid, 'Lafayette', 'lafayette', 'America/Chicago', 30.2241, -92.0198)`,
    [CITY_ID]
  )
})

async function seedSource(
  overrides: Partial<{
    source_type: string
    auto_approve: boolean
    processing_mode: string | null
    city_id: string | null
    consecutive_zero_result_scrapes: number
    stale_escalated_at: string | null
  }> = {}
): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `INSERT INTO public.event_sources
       (name, url, source_type, city_id, auto_approve, processing_mode,
        consecutive_zero_result_scrapes, stale_escalated_at)
     VALUES ('Test Source', 'https://example.com/feed', $1, $2::uuid, $3, $4::public.event_processing_mode,
             $5, $6::timestamptz)
     RETURNING id::text`,
    [
      overrides.source_type ?? "rss",
      overrides.city_id === undefined ? CITY_ID : overrides.city_id,
      overrides.auto_approve ?? false,
      overrides.processing_mode ?? null,
      overrides.consecutive_zero_result_scrapes ?? 0,
      overrides.stale_escalated_at ?? null,
    ]
  )
  return rows[0]!.id
}

async function seedRun(sourceId: string): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `INSERT INTO public.source_runs (source_id, status) VALUES ($1::uuid, 'running')
     RETURNING id::text`,
    [sourceId]
  )
  return rows[0]!.id
}

async function loadSource(sourceId: string): Promise<EventSourceRow> {
  const rows = await db.query<EventSourceRow>(
    `SELECT id::text, name, url, source_type, extraction_mode, processing_mode,
            city_id::text, is_active, auto_approve, scrape_interval_hours,
            last_scraped_at, last_status, error_count, date_window_days,
            consecutive_zero_result_scrapes, stale_escalated_at
     FROM public.event_sources WHERE id = $1::uuid`,
    [sourceId]
  )
  return rows[0]!
}

function buildParsed(overrides: Partial<ParsedEvent> = {}): ParsedEvent {
  return {
    title: "Family Story Time",
    description: "Books and songs.",
    startDatetime: "2026-06-20T14:00:00.000Z",
    endDatetime: null,
    venueName: "City Library",
    address: "100 Main St",
    sourceUrl: "https://example.com/event/1",
    imageUrl: null,
    images: [],
    price: null,
    isFree: true,
    ...overrides,
  }
}

function payloadFor(sourceId: string, parsed: ParsedEvent): Record<string, unknown> {
  return {
    title: parsed.title,
    description: parsed.description,
    start_datetime: parsed.startDatetime,
    end_datetime: parsed.endDatetime,
    timezone: "America/Chicago",
    venue_name: parsed.venueName,
    address: parsed.address,
    city_id: CITY_ID,
    source_url: parsed.sourceUrl,
    source_name: "Test Source",
    images: parsed.images,
    price: parsed.price,
    is_free: parsed.isFree,
    is_outdoor: null,
    latitude: 30.2241,
    longitude: -92.0198,
    source_id: sourceId,
  }
}

describe("bulk_import_scrape_events (real SQL)", () => {
  it("inserts manual_review events as drafts and enqueues the tag queue", async () => {
    const sourceId = await seedSource({ auto_approve: false })
    const runId = await seedRun(sourceId)

    const result = await repository.bulkImportScrapeEvents(runId, sourceId, [
      payloadFor(sourceId, buildParsed()),
    ])

    expect(result).toEqual({ imported: 1, updated: 0, skipped: 0, enqueued: 1 })

    const events = await db.query<{ status: string; llm_review_status: string }>(
      "SELECT status::text, llm_review_status::text FROM public.events"
    )
    expect(events).toEqual([{ status: "draft", llm_review_status: "not_required" }])

    const tagQueue = await db.query<{ status: string; trigger_type: string }>(
      "SELECT status::text, trigger_type FROM public.event_tag_queue"
    )
    expect(tagQueue).toEqual([{ status: "pending", trigger_type: "import" }])
  })

  it("publishes auto_approve events immediately", async () => {
    const sourceId = await seedSource({ auto_approve: true })
    const runId = await seedRun(sourceId)

    await repository.bulkImportScrapeEvents(runId, sourceId, [payloadFor(sourceId, buildParsed())])

    const events = await db.query<{ status: string }>("SELECT status::text FROM public.events")
    expect(events).toEqual([{ status: "published" }])
  })

  it("routes llm_review sources to the review queue with pending review status", async () => {
    const sourceId = await seedSource({ processing_mode: "llm_review" })
    const runId = await seedRun(sourceId)

    const result = await repository.bulkImportScrapeEvents(runId, sourceId, [
      payloadFor(sourceId, buildParsed()),
    ])
    expect(result).toEqual({ imported: 1, updated: 0, skipped: 0, enqueued: 1 })

    const events = await db.query<{ status: string; llm_review_status: string }>(
      "SELECT status::text, llm_review_status::text FROM public.events"
    )
    expect(events).toEqual([{ status: "draft", llm_review_status: "pending" }])

    const reviewQueue = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.event_llm_review_queue"
    )
    expect(reviewQueue[0]?.count).toBe("1")
    const tagQueue = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.event_tag_queue"
    )
    expect(tagQueue[0]?.count).toBe("0")
  })

  it("updates the existing row on source_url re-import and respects admin-locked fields", async () => {
    const sourceId = await seedSource()
    const runId = await seedRun(sourceId)

    await repository.bulkImportScrapeEvents(runId, sourceId, [payloadFor(sourceId, buildParsed())])
    await db.query("UPDATE public.events SET admin_locked_fields = ARRAY['title']")

    const rerun = await repository.bulkImportScrapeEvents(runId, sourceId, [
      payloadFor(
        sourceId,
        buildParsed({ title: "Renamed By Scraper", description: "Updated description." })
      ),
    ])
    expect(rerun).toEqual({ imported: 0, updated: 1, skipped: 0, enqueued: 0 })

    const events = await db.query<{ title: string; description: string }>(
      "SELECT title, description FROM public.events"
    )
    // title is locked (admin wins); description follows the scraper.
    expect(events).toEqual([{ title: "Family Story Time", description: "Updated description." }])
  })

  it("raises P0002 for an unknown source", async () => {
    const runId = await seedRun(await seedSource())
    await expect(
      repository.bulkImportScrapeEvents(runId, "22222222-2222-4222-8222-222222222222", [])
    ).rejects.toMatchObject({ code: "P0002" })
  })
})

describe("find_cross_source_event_candidates (real SQL)", () => {
  it("returns UTC ISO datetimes, scoped to city and window, excluding rejected", async () => {
    const sourceId = await seedSource()
    await db.query(
      `INSERT INTO public.events (title, start_datetime, city_id, source_id, status)
       VALUES
         ('In Window',      '2026-06-20T14:00:00Z', $1::uuid, $2::uuid, 'published'),
         ('Rejected Twin',  '2026-06-20T14:00:00Z', $1::uuid, $2::uuid, 'rejected'),
         ('Out Of Window',  '2026-06-22T14:00:00Z', $1::uuid, $2::uuid, 'published')`,
      [CITY_ID, sourceId]
    )

    const candidates = await repository.findCrossSourceEventCandidates({
      cityId: CITY_ID,
      startFrom: "2026-06-20T10:00:00.000Z",
      startTo: "2026-06-20T18:00:00.000Z",
      limit: 1000,
    })

    expect(candidates.map((c) => c.title)).toEqual(["In Window"])
    // The repository re-serializes timestamptz as UTC ISO so fingerprint
    // minute-slicing matches parser payload datetimes.
    expect(candidates[0]?.start_datetime).toBe("2026-06-20T14:00:00.000Z")
  })
})

describe("importParsedSourceEvents end to end (real repository)", () => {
  it("imports, dedupes cross-source duplicates, and finalizes run + source", async () => {
    const otherSourceId = await seedSource()
    // Existing event from ANOTHER source 2h away — a cross-source duplicate.
    await db.query(
      `INSERT INTO public.events (title, start_datetime, city_id, source_id, status)
       VALUES ('Family Story Time', '2026-06-20T16:00:00Z', $1::uuid, $2::uuid, 'published')`,
      [CITY_ID, otherSourceId]
    )

    const sourceId = await seedSource()
    const runId = await seedRun(sourceId)
    const source = await loadSource(sourceId)

    const result = await importParsedSourceEvents(repository, source, runId, [
      buildParsed(), // duplicate of the seeded event → skipped
      buildParsed({
        title: "Toddler Music Morning",
        startDatetime: "2026-06-21T15:00:00.000Z",
        sourceUrl: "https://example.com/event/2",
      }),
    ])

    expect(result.status).toBe("success")
    expect(result.eventsFound).toBe(2)
    expect(result.eventsImported).toBe(1)
    expect(result.eventsSkipped).toBe(1)

    const imported = await db.query<{ title: string; timezone: string; latitude: string }>(
      `SELECT title, timezone, latitude::text
       FROM public.events WHERE source_id = $1::uuid`,
      [sourceId]
    )
    // City timezone + centroid resolved from the cities table.
    expect(imported).toEqual([
      { title: "Toddler Music Morning", timezone: "America/Chicago", latitude: "30.2241" },
    ])

    const run = await db.query<{
      status: string
      events_found: number
      events_imported: number
      events_skipped: number
      completed_at: string | null
    }>(
      `SELECT status, events_found, events_imported, events_skipped, completed_at
       FROM public.source_runs WHERE id = $1::uuid`,
      [runId]
    )
    expect(run[0]).toMatchObject({
      status: "success",
      events_found: 2,
      events_imported: 1,
      events_skipped: 1,
    })
    expect(run[0]?.completed_at).not.toBeNull()

    const sourceAfter = await loadSource(sourceId)
    expect(sourceAfter.last_status).toBe("success")
    expect(sourceAfter.error_count).toBe(0)
    expect(sourceAfter.consecutive_zero_result_scrapes).toBe(0)
    expect(sourceAfter.last_scraped_at).not.toBeNull()
  })

  it("escalates to stale after the third consecutive zero-result run and audits it", async () => {
    const sourceId = await seedSource({ consecutive_zero_result_scrapes: 2 })
    const runId = await seedRun(sourceId)
    const source = await loadSource(sourceId)

    const result = await importParsedSourceEvents(repository, source, runId, [])
    expect(result.status).toBe("success")

    const sourceAfter = await loadSource(sourceId)
    expect(sourceAfter.last_status).toBe("stale")
    expect(sourceAfter.consecutive_zero_result_scrapes).toBe(3)
    expect(sourceAfter.stale_escalated_at).not.toBeNull()

    const audit = await db.query<{ action: string; target_id: string }>(
      "SELECT action, target_id::text FROM public.admin_audit_log"
    )
    expect(audit).toEqual([{ action: "source.stale_escalated", target_id: sourceId }])
  })

  it("keeps the original stale_escalated_at on later zero-result runs", async () => {
    const escalatedAt = "2026-06-19T00:00:00.000Z"
    const sourceId = await seedSource({
      consecutive_zero_result_scrapes: 5,
      stale_escalated_at: escalatedAt,
    })
    const runId = await seedRun(sourceId)
    const source = await loadSource(sourceId)

    await importParsedSourceEvents(repository, source, runId, [])

    const sourceAfter = await loadSource(sourceId)
    expect(sourceAfter.consecutive_zero_result_scrapes).toBe(6)
    expect(sourceAfter.stale_escalated_at).toContain("2026-06-19")
    // No new audit row.
    const audit = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM public.admin_audit_log"
    )
    expect(audit[0]?.count).toBe("0")
  })
})

describe("IngestionRepository lookups", () => {
  it("resolves the city timezone with UTC fallback", async () => {
    expect(await repository.resolveCityTimezone(CITY_ID)).toBe("America/Chicago")
    expect(await repository.resolveCityTimezone(null)).toBe("UTC")
    expect(await repository.resolveCityTimezone("33333333-3333-4333-8333-333333333333")).toBe("UTC")
  })

  it("returns the city centroid as numbers", async () => {
    expect(await repository.fetchCityCentroid(CITY_ID)).toEqual({
      latitude: 30.2241,
      longitude: -92.0198,
    })
    expect(await repository.fetchCityCentroid(null)).toBeNull()
  })
})
