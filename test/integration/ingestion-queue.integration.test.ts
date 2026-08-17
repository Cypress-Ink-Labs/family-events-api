import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { IngestionRepository } from "../../src/pipeline/ingestion/ingestion.repository.js"
import { importParsedSourceEvents } from "../../src/pipeline/ingestion/process-source.js"
import { processSourceQueueBatch } from "../../src/pipeline/ingestion/source-queue.worker.js"
import type { SourceQueueWorkerDependencies } from "../../src/pipeline/ingestion/source-queue.worker.js"
import type { SourceParser } from "../../src/pipeline/ingestion/parsers/index.js"
import type { ParsedEvent, SourceType } from "../../src/pipeline/ingestion/types.js"
import type { DbService } from "../../src/db/db.service.js"

import { createIntegrationDb } from "./db.js"
import { ensureIngestionSchema, truncateIngestion } from "./ingestion-catalog.js"

// U28 slice D: the source_scrape_queue RPCs (claim SKIP LOCKED, retry ladder,
// reap, run_due_source_scrapes, cleanup) — REAL SQL extracted verbatim from
// the backend baseline — plus a full worker pass against real Postgres.

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
    is_active: boolean
    last_scraped_at: string | null
    scrape_interval_hours: number
    source_type: string
    auto_approve: boolean
  }> = {}
): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `INSERT INTO public.event_sources
       (name, url, source_type, city_id, is_active, auto_approve, scrape_interval_hours, last_scraped_at)
     VALUES ('Queue Source', 'https://example.com/feed', $1, $2::uuid, $3, $4, $5, $6::timestamptz)
     RETURNING id::text`,
    [
      overrides.source_type ?? "rss",
      CITY_ID,
      overrides.is_active ?? true,
      overrides.auto_approve ?? false,
      overrides.scrape_interval_hours ?? 24,
      overrides.last_scraped_at ?? null,
    ]
  )
  return rows[0]!.id
}

async function enqueue(
  sourceId: string,
  overrides: Partial<{ status: string; next_attempt_at: string; started_at: string | null }> = {}
): Promise<number> {
  const rows = await db.query<{ id: number }>(
    `INSERT INTO public.source_scrape_queue (source_id, trigger_type, status, next_attempt_at, started_at)
     VALUES ($1::uuid, 'manual', $2::public.source_scrape_queue_status,
             COALESCE($3::timestamptz, now()), $4::timestamptz)
     RETURNING id::int AS id`,
    [
      sourceId,
      overrides.status ?? "pending",
      overrides.next_attempt_at ?? null,
      overrides.started_at ?? null,
    ]
  )
  return rows[0]!.id
}

async function queueRowById(id: number) {
  const rows = await db.query<{
    status: string
    attempt_count: number
    started_at: string | null
    next_attempt_at: string
    last_error: string | null
    skip_reason: string | null
    source_run_id: string | null
  }>(
    `SELECT status::text, attempt_count, started_at, next_attempt_at, last_error, skip_reason,
            source_run_id::text
     FROM public.source_scrape_queue WHERE id = $1::bigint`,
    [id]
  )
  return rows[0]!
}

describe("run_due_source_scrapes (real SQL)", () => {
  it("enqueues due active sources once and skips fresh/disabled/duplicated ones", async () => {
    const dueNever = await seedSource() // never scraped → due
    const dueStale = await seedSource({
      last_scraped_at: "2026-06-01T00:00:00Z",
      scrape_interval_hours: 1,
    })
    await seedSource({ last_scraped_at: new Date().toISOString() }) // fresh → not due
    await seedSource({ is_active: false }) // disabled → never enqueued
    await enqueue(dueStale) // live queue row → ON CONFLICT DO NOTHING

    await repository.runDueSourceScrapes()

    const rows = await db.query<{ source_id: string; trigger_type: string }>(
      "SELECT source_id::text, trigger_type FROM public.source_scrape_queue ORDER BY id"
    )
    // dueStale keeps its single pre-existing row; dueNever gains one scheduled row.
    expect(rows.filter((row) => row.source_id === dueStale).length).toBe(1)
    expect(
      rows.filter((row) => row.source_id === dueNever && row.trigger_type === "scheduled").length
    ).toBe(1)
    expect(rows.length).toBe(2)
  })
})

describe("source_scrape_queue claim/retry/reap RPCs (real SQL)", () => {
  it("claims oldest-first, marks processing, and a second claim finds nothing", async () => {
    const sourceId = await seedSource()
    const first = await enqueue(sourceId, { next_attempt_at: "2026-06-01T00:00:00Z" })

    const claimed = await repository.claimSourceScrapeQueueBatch(1)
    expect(claimed.map((row) => row.id)).toEqual([first])
    expect((await queueRowById(first)).status).toBe("processing")

    expect(await repository.claimSourceScrapeQueueBatch(1)).toEqual([])
  })

  it("does not claim rows parked in the future", async () => {
    const sourceId = await seedSource()
    await enqueue(sourceId, { next_attempt_at: "2199-01-01T00:00:00Z" })
    expect(await repository.claimSourceScrapeQueueBatch(1)).toEqual([])
    expect(await repository.hasClaimableSourceScrapeRows()).toBe(false)
  })

  it("markStarted stamps started_at and increments attempt_count", async () => {
    const sourceId = await seedSource()
    const id = await enqueue(sourceId)
    await repository.claimSourceScrapeQueueBatch(1)

    const started = await repository.markSourceScrapeQueueStarted(id)
    expect(started.attempt_count).toBe(1)
    const row = await queueRowById(id)
    expect(row.started_at).not.toBeNull()
  })

  it("schedule_retry parks with the 5/15/60 ladder and dead-letters at attempt 4", async () => {
    const sourceId = await seedSource()
    const id = await enqueue(sourceId)

    await repository.scheduleSourceScrapeRetry(id, 1, "boom")
    let row = await queueRowById(id)
    expect(row.status).toBe("pending")
    expect(row.last_error).toBe("boom")
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 4 * 60_000)

    await repository.scheduleSourceScrapeRetry(id, 4, "gave up")
    row = await queueRowById(id)
    expect(row.status).toBe("dead")
    expect(row.last_error).toBe("gave up")
  })

  it("release returns unstarted claims to pending", async () => {
    const sourceId = await seedSource()
    const id = await enqueue(sourceId)
    await repository.claimSourceScrapeQueueBatch(1)

    const released = await repository.releaseUnstartedSourceScrapeQueueRows([id])
    expect(released).toBe(1)
    expect((await queueRowById(id)).status).toBe("pending")
  })

  it("reap returns rows stuck in processing to retrying", async () => {
    const sourceId = await seedSource()
    const id = await enqueue(sourceId, {
      status: "processing",
      started_at: "2026-06-01T00:00:00Z",
    })

    const reaped = await repository.reapStuckSourceScrapeQueueRows()
    expect(reaped).toBe(1)
    const row = await queueRowById(id)
    expect(row.status).toBe("retrying")
    expect(row.last_error).toBe("reaped after stuck in processing")
  })

  it("mark skipped resolves the row as succeeded with a skip reason", async () => {
    const sourceId = await seedSource()
    const id = await enqueue(sourceId)

    await repository.markSourceScrapeQueueSkipped(id, "source deleted before processing")
    const row = await queueRowById(id)
    expect(row.status).toBe("succeeded")
    expect(row.skip_reason).toBe("source deleted before processing")
  })
})

describe("run_cleanup_stale_runs (real SQL)", () => {
  it("times out runs stuck in running for over 15 minutes", async () => {
    const sourceId = await seedSource()
    const stuck = await db.query<{ id: string }>(
      `INSERT INTO public.source_runs (source_id, status, started_at)
       VALUES ($1::uuid, 'running', now() - interval '20 minutes')
       RETURNING id::text`,
      [sourceId]
    )
    await db.query(
      `INSERT INTO public.source_runs (source_id, status) VALUES ($1::uuid, 'running')`,
      [sourceId]
    )

    await repository.runCleanupStaleRuns()

    const rows = await db.query<{ id: string; status: string; error_log: string | null }>(
      "SELECT id::text, status, error_log FROM public.source_runs ORDER BY started_at"
    )
    expect(rows[0]?.id).toBe(stuck[0]?.id)
    expect(rows[0]?.status).toBe("error")
    expect(rows[0]?.error_log).toContain("timed out")
    expect(rows[1]?.status).toBe("running")
  })
})

describe("worker pass against real Postgres", () => {
  function stubDependencies(events: ParsedEvent[]): SourceQueueWorkerDependencies {
    const stubParser: SourceParser = {
      type: "rss",
      fetchArtifact: async (source) => ({
        url: source.url,
        contentType: "application/xml",
        body: "<rss/>",
      }),
      extractEvents: async () => events,
    }
    const parsers = Object.fromEntries(
      (
        [
          "brec",
          "downtownlafayette",
          "ical",
          "lcglafayette",
          "localhop",
          "macaronikid",
          "manual",
          "rss",
          "website",
        ] as SourceType[]
      ).map((type) => [type, { ...stubParser, type }])
    ) as Record<SourceType, SourceParser>
    return {
      parsers,
      importParsedSourceEvents,
      extractWithLlm: async () => {
        throw new Error("LLM must not be called for deterministic sources")
      },
    }
  }

  it("claims, extracts, imports, traces, and resolves the queue row", async () => {
    const sourceId = await seedSource({ auto_approve: true })
    const queueId = await enqueue(sourceId)

    const summary = await processSourceQueueBatch(
      repository,
      stubDependencies([
        {
          title: "Queue Story Time",
          description: "From the worker",
          startDatetime: "2026-06-20T14:00:00.000Z",
          endDatetime: null,
          venueName: "Library",
          address: "100 Main St",
          sourceUrl: "https://example.com/event/queued",
          imageUrl: null,
          images: [],
          price: null,
          isFree: true,
        },
      ])
    )

    expect(summary).toMatchObject({ claimed: 1, started: 1, outcome: "succeeded" })

    const row = await queueRowById(queueId)
    expect(row.status).toBe("succeeded")
    expect(row.attempt_count).toBe(1)
    expect(row.source_run_id).not.toBeNull()

    const events = await db.query<{ title: string; status: string; timezone: string }>(
      "SELECT title, status::text, timezone FROM public.events"
    )
    expect(events).toEqual([
      { title: "Queue Story Time", status: "published", timezone: "America/Chicago" },
    ])

    const runs = await db.query<{ status: string; events_imported: number }>(
      "SELECT status, events_imported FROM public.source_runs"
    )
    expect(runs).toEqual([{ status: "success", events_imported: 1 }])

    const traces = await db.query<{
      extractor: string
      status: string
      parsed_event_count: number
    }>("SELECT extractor, status, parsed_event_count FROM public.source_extraction_traces")
    expect(traces).toEqual([
      { extractor: "deterministic", status: "success", parsed_event_count: 1 },
    ])
  })

  it("schedules a retry when extraction fails and records the trace + run error", async () => {
    const sourceId = await seedSource()
    const queueId = await enqueue(sourceId)

    const failing = stubDependencies([])
    for (const parser of Object.values(failing.parsers)) {
      parser.fetchArtifact = async () => {
        throw new Error("connection refused")
      }
    }

    const summary = await processSourceQueueBatch(repository, failing)
    expect(summary.outcome).toBe("retry")

    const row = await queueRowById(queueId)
    expect(row.status).toBe("pending")
    expect(row.last_error).toContain("connection refused")
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now())

    const runs = await db.query<{ status: string; error_log: string | null }>(
      "SELECT status, error_log FROM public.source_runs"
    )
    expect(runs[0]?.status).toBe("error")
    expect(runs[0]?.error_log).toContain("connection refused")

    const traces = await db.query<{ extractor: string; status: string }>(
      "SELECT extractor, status FROM public.source_extraction_traces"
    )
    expect(traces).toEqual([{ extractor: "deterministic", status: "error" }])
  })
})
