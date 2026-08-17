import { describe, expect, it } from "vitest"

import {
  planSourceQueueClaimHandling,
  processSourceQueueBatch,
  processSourceQueueRow,
  shouldFallbackToLlm,
  sourceRetryDelayMinutes,
  type ExtractionTraceInsert,
  type SourceFailureNotice,
  type SourceQueueDb,
  type SourceQueueRow,
  type SourceQueueWorkerDependencies,
} from "./source-queue.worker.js"
import type {
  EventSourceRow,
  FetchedArtifact,
  ParsedEvent,
  SourceResult,
  SourceType,
} from "./types.js"
import type { SourceParser } from "./parsers/index.js"
import type {
  AdminAuditLogInsert,
  BulkImportResult,
  CrossSourceCandidateRow,
  EventSourceRunUpdate,
  SourceRunFinalization,
  SourceRunProgress,
} from "./process-source.js"

// Ported from family-events-backend process-source-queue/lib/worker_test.ts
// (U28), converted from Deno.test to vitest. The supabase client fake became a
// FakeQueueDb implementing the SourceQueueDb seam; scenarios and expected
// values are unchanged. processSourceQueueBatch cases added (upstream tested
// it only via the pure claim-planning helper).

describe("sourceRetryDelayMinutes", () => {
  it("uses bounded exponential backoff", () => {
    expect(sourceRetryDelayMinutes(1)).toBe(5)
    expect(sourceRetryDelayMinutes(2)).toBe(15)
    expect(sourceRetryDelayMinutes(3)).toBe(60)
    expect(sourceRetryDelayMinutes(4)).toBe(null)
  })
})

describe("planSourceQueueClaimHandling", () => {
  it("starts one row and releases the rest", () => {
    expect(planSourceQueueClaimHandling([1, 2, 3], 0)).toEqual({
      start: 1,
      release: [2, 3],
    })
    expect(planSourceQueueClaimHandling([1, 2], 120_000)).toEqual({
      start: null,
      release: [1, 2],
    })
  })
})

describe("shouldFallbackToLlm", () => {
  it("only falls back in hybrid mode", () => {
    expect(shouldFallbackToLlm("deterministic_then_llm", 0, null)).toBe(true)
    expect(shouldFallbackToLlm("deterministic_then_llm", 2, null)).toBe(false)
    expect(shouldFallbackToLlm("deterministic", 0, new Error("parser failed"))).toBe(false)
    expect(shouldFallbackToLlm("llm", 0, null)).toBe(false)
  })
})

function queueRow(overrides: Partial<SourceQueueRow> = {}): SourceQueueRow {
  return {
    id: 42,
    source_id: "source-1",
    source_run_id: null,
    attempt_count: 0,
    ...overrides,
  }
}

function source(overrides: Partial<EventSourceRow> = {}): EventSourceRow {
  return {
    id: "source-1",
    name: "Source",
    url: "https://example.com/events",
    source_type: "website",
    extraction_mode: "deterministic",
    processing_mode: "manual_review",
    city_id: null,
    is_active: true,
    auto_approve: false,
    scrape_interval_hours: 24,
    last_scraped_at: null,
    last_status: null,
    error_count: 0,
    date_window_days: null,
    consecutive_zero_result_scrapes: 0,
    stale_escalated_at: null,
    ...overrides,
  }
}

function parsedEvent(overrides: Partial<ParsedEvent> = {}): ParsedEvent {
  return {
    title: "Story Time",
    description: "Books and songs",
    startDatetime: "2026-06-01T15:00:00.000Z",
    endDatetime: null,
    venueName: "Library",
    address: null,
    sourceUrl: "https://example.com/story-time",
    imageUrl: null,
    images: [],
    price: null,
    isFree: true,
    ...overrides,
  }
}

function parser(overrides: Partial<SourceParser> = {}): SourceParser {
  return {
    type: "website",
    fetchArtifact: () =>
      Promise.resolve({
        url: "https://example.com/events",
        contentType: "text/html",
        body: "<html></html>",
      } satisfies FetchedArtifact),
    extractEvents: () => Promise.resolve([parsedEvent()]),
    ...overrides,
  } as SourceParser
}

function createDependencies(
  overrides: {
    parser?: SourceParser
    importParsedSourceEvents?: (parsedEvents: ParsedEvent[]) => Promise<SourceResult>
    extractWithLlm?: SourceQueueWorkerDependencies["extractWithLlm"]
  } = {}
): SourceQueueWorkerDependencies {
  return {
    parsers: {
      website: overrides.parser ?? parser(),
      rss: parser({ type: "rss" }),
      ical: parser({ type: "ical" }),
      manual: parser({ type: "manual" }),
      macaronikid: parser({ type: "macaronikid" }),
      brec: parser({ type: "brec" }),
      downtownlafayette: parser({ type: "downtownlafayette" }),
      lcglafayette: parser({ type: "lcglafayette" }),
      localhop: parser({ type: "localhop" }),
    } as Record<SourceType, SourceParser>,
    importParsedSourceEvents: (_db, sourceRow, _runId, parsedEvents) =>
      overrides.importParsedSourceEvents?.(parsedEvents) ??
      Promise.resolve({
        sourceId: sourceRow.id,
        status: "success",
        eventsFound: parsedEvents.length,
        eventsImported: parsedEvents.length,
        eventsSkipped: 0,
        error: null,
      }),
    extractWithLlm:
      overrides.extractWithLlm ??
      (() =>
        Promise.resolve({
          events: [parsedEvent({ title: "LLM Event" })],
          config: {
            provider: "test",
            model: "test-model",
            baseUrl: "https://llm.test",
            apiKey: "test",
            configured: true,
          },
          latencyMs: 12,
        })),
  }
}

/**
 * Fake SourceQueueDb mirroring the upstream fake supabase client: records
 * skips/retries/traces/successes and serves the configured source row.
 */
class FakeQueueDb implements SourceQueueDb {
  constructor(private readonly sourceRow: EventSourceRow | null = source()) {}

  startedAttemptCount = 1
  claimable: SourceQueueRow[] = []
  reaped = 0

  skips: Array<{ queueId: number; reason: string }> = []
  retries: Array<{ queueId: number; attemptCount: number; error: string }> = []
  traces: ExtractionTraceInsert[] = []
  runErrors: Array<{ runId: string; error: string }> = []
  succeeded: number[] = []
  released: number[][] = []
  createdRuns: string[] = []
  linkedRuns: Array<{ queueId: number; runId: string }> = []

  async reapStuckSourceScrapeQueueRows(): Promise<number> {
    return this.reaped
  }

  async claimSourceScrapeQueueBatch(limit: number): Promise<SourceQueueRow[]> {
    return this.claimable.slice(0, limit)
  }

  async releaseUnstartedSourceScrapeQueueRows(claimedIds: number[]): Promise<number> {
    this.released.push(claimedIds)
    return claimedIds.length
  }

  async markSourceScrapeQueueSkipped(queueId: number, reason: string): Promise<void> {
    this.skips.push({ queueId, reason })
  }

  async markSourceScrapeQueueStarted(queueId: number): Promise<SourceQueueRow> {
    return queueRow({ id: queueId, attempt_count: this.startedAttemptCount })
  }

  async scheduleSourceScrapeRetry(
    queueId: number,
    attemptCount: number,
    error: string
  ): Promise<void> {
    this.retries.push({ queueId, attemptCount, error })
  }

  async markSourceScrapeQueueSucceeded(queueId: number): Promise<void> {
    this.succeeded.push(queueId)
  }

  async getEventSource(): Promise<EventSourceRow | null> {
    return this.sourceRow
  }

  async fetchCityTimezone(): Promise<string | null> {
    return null
  }

  async createSourceRun(): Promise<string> {
    const runId = `run-${this.createdRuns.length + 1}`
    this.createdRuns.push(runId)
    return runId
  }

  async linkSourceRunToQueueRow(queueId: number, runId: string): Promise<void> {
    this.linkedRuns.push({ queueId, runId })
  }

  async insertExtractionTrace(row: ExtractionTraceInsert): Promise<void> {
    this.traces.push(row)
  }

  async markSourceRunError(runId: string, error: string): Promise<void> {
    this.runErrors.push({ runId, error })
  }

  // ProcessSourceDb surface — unused here because importParsedSourceEvents is
  // stubbed in every test's dependencies.
  async resolveCityTimezone(): Promise<string> {
    return "UTC"
  }
  async fetchCityCentroid(): Promise<{ latitude: number | null; longitude: number | null } | null> {
    return null
  }
  async updateSourceRunProgress(_runId: string, _progress: SourceRunProgress): Promise<void> {}
  async findCrossSourceEventCandidates(): Promise<CrossSourceCandidateRow[]> {
    return []
  }
  async bulkImportScrapeEvents(): Promise<BulkImportResult | null> {
    return { imported: 0, updated: 0, skipped: 0, enqueued: 0 }
  }
  async finalizeSourceRun(_runId: string, _finalization: SourceRunFinalization): Promise<void> {}
  async updateEventSourceAfterRun(
    _sourceId: string,
    _update: EventSourceRunUpdate
  ): Promise<void> {}
  async insertAdminAuditLog(_row: AdminAuditLogInsert): Promise<void> {}
  async invokeProcessTagQueue(): Promise<void> {}
}

describe("processSourceQueueRow", () => {
  it("skips rows without a source id", async () => {
    const db = new FakeQueueDb()

    const result = await processSourceQueueRow(
      db,
      queueRow({ source_id: null }),
      createDependencies()
    )

    expect(result).toEqual({ outcome: "skipped", imported: 0 })
    expect(db.skips).toEqual([{ queueId: 42, reason: "source missing from queue row" }])
  })

  it("skips deleted sources", async () => {
    const db = new FakeQueueDb(null)
    const result = await processSourceQueueRow(db, queueRow(), createDependencies())
    expect(result).toEqual({ outcome: "skipped", imported: 0 })
    expect(db.skips.at(-1)).toEqual({ queueId: 42, reason: "source deleted before processing" })
  })

  it("skips disabled sources", async () => {
    const db = new FakeQueueDb(source({ is_active: false }))
    const result = await processSourceQueueRow(db, queueRow(), createDependencies())
    expect(result).toEqual({ outcome: "skipped", imported: 0 })
    expect(db.skips.at(-1)).toEqual({ queueId: 42, reason: "source disabled before processing" })
  })

  it("marks successful deterministic imports succeeded", async () => {
    const db = new FakeQueueDb()
    let processedEvents: ParsedEvent[] = []

    const result = await processSourceQueueRow(
      db,
      queueRow(),
      createDependencies({
        importParsedSourceEvents: (events) => {
          processedEvents = events
          return Promise.resolve({
            sourceId: "source-1",
            status: "success",
            eventsFound: events.length,
            eventsImported: 1,
            eventsSkipped: 0,
            error: null,
          })
        },
      })
    )

    expect(result).toEqual({ outcome: "succeeded", imported: 1 })
    expect(processedEvents.map((event) => event.title)).toEqual(["Story Time"])
    expect(db.succeeded).toEqual([42])
  })

  it("schedules retry when parser fetch fails", async () => {
    const db = new FakeQueueDb()

    const result = await processSourceQueueRow(
      db,
      queueRow(),
      createDependencies({
        parser: parser({
          fetchArtifact: () => Promise.reject(new Error("fetch failed")),
        }),
      })
    )

    expect(result).toEqual({ outcome: "retry", imported: 0 })
    expect(db.traces.at(-1)?.status).toBe("error")
    expect(db.runErrors.at(-1)?.error).toBe("fetch failed")
    expect(db.retries.at(-1)).toEqual({ queueId: 42, attemptCount: 1, error: "fetch failed" })
  })

  it("imports empty deterministic extraction results without retrying", async () => {
    const db = new FakeQueueDb(source({ extraction_mode: "deterministic" }))
    let importedEvents: ParsedEvent[] | null = null

    const result = await processSourceQueueRow(
      db,
      queueRow(),
      createDependencies({
        parser: parser({ extractEvents: () => Promise.resolve([]) }),
        importParsedSourceEvents: (events) => {
          importedEvents = events
          return Promise.resolve({
            sourceId: "source-1",
            status: "success",
            eventsFound: 0,
            eventsImported: 0,
            eventsSkipped: 0,
            error: null,
          })
        },
      })
    )

    expect(result).toEqual({ outcome: "succeeded", imported: 0 })
    expect(importedEvents).toEqual([])
    expect(db.retries).toEqual([])
  })

  it("retries deterministic extraction errors", async () => {
    const db = new FakeQueueDb(source({ extraction_mode: "deterministic" }))

    const result = await processSourceQueueRow(
      db,
      queueRow(),
      createDependencies({
        parser: parser({ extractEvents: () => Promise.reject(new Error("extract failed")) }),
      })
    )

    expect(result).toEqual({ outcome: "retry", imported: 0 })
    expect(db.retries.at(-1)).toEqual({ queueId: 42, attemptCount: 1, error: "extract failed" })
  })

  it("pings the operator once per failed run", async () => {
    const db = new FakeQueueDb()
    const notices: SourceFailureNotice[] = []

    const result = await processSourceQueueRow(db, queueRow(), {
      ...createDependencies({
        parser: parser({ fetchArtifact: () => Promise.reject(new Error("fetch failed")) }),
      }),
      notifyFailure: (notice) => {
        notices.push(notice)
        return Promise.resolve()
      },
    })

    expect(result).toEqual({ outcome: "retry", imported: 0 })
    expect(notices).toEqual([{ kind: "run_failed", sourceName: "Source", error: "fetch failed" }])
  })

  it("pings a dead-letter when retries are exhausted", async () => {
    const db = new FakeQueueDb()
    // mark_source_scrape_queue_started returns attempt_count 4 — the
    // scheduleRetry RPC dead-letters at >= 4, so the notice must say so.
    db.startedAttemptCount = 4
    const notices: SourceFailureNotice[] = []

    const result = await processSourceQueueRow(db, queueRow(), {
      ...createDependencies({
        parser: parser({ fetchArtifact: () => Promise.reject(new Error("still broken")) }),
      }),
      notifyFailure: (notice) => {
        notices.push(notice)
        return Promise.resolve()
      },
    })

    expect(result).toEqual({ outcome: "retry", imported: 0 })
    expect(notices).toEqual([{ kind: "dead_letter", sourceName: "Source", error: "still broken" }])
  })

  it("sends no ping on success", async () => {
    const db = new FakeQueueDb()
    const notices: SourceFailureNotice[] = []

    const result = await processSourceQueueRow(db, queueRow(), {
      ...createDependencies(),
      notifyFailure: (notice) => {
        notices.push(notice)
        return Promise.resolve()
      },
    })

    expect(result).toEqual({ outcome: "succeeded", imported: 1 })
    expect(notices).toEqual([])
  })

  it("result is unchanged when the failure ping throws", async () => {
    const db = new FakeQueueDb()

    const result = await processSourceQueueRow(db, queueRow(), {
      ...createDependencies({
        parser: parser({ fetchArtifact: () => Promise.reject(new Error("fetch failed")) }),
      }),
      notifyFailure: () => Promise.reject(new Error("telegram down")),
    })

    expect(result).toEqual({ outcome: "retry", imported: 0 })
    expect(db.retries.at(-1)).toEqual({ queueId: 42, attemptCount: 1, error: "fetch failed" })
  })

  it("records deterministic-to-LLM fallback traces", async () => {
    const db = new FakeQueueDb(source({ extraction_mode: "deterministic_then_llm" }))

    const result = await processSourceQueueRow(
      db,
      queueRow(),
      createDependencies({
        parser: parser({ extractEvents: () => Promise.resolve([]) }),
      })
    )

    expect(result).toEqual({ outcome: "succeeded", imported: 1 })
    expect(db.traces.map((trace) => trace.status)).toEqual(["fallback", "success"])
    expect(db.traces.at(-1)?.extractor).toBe("llm")
    expect(db.traces.at(-1)?.fallback_reason).toBe("deterministic extractor returned no events")
  })
})

describe("processSourceQueueBatch", () => {
  it("returns an idle summary when nothing is claimable", async () => {
    const db = new FakeQueueDb()
    const summary = await processSourceQueueBatch(db, createDependencies())
    expect(summary).toEqual({ claimed: 0, started: 0, released: 0, reaped: 0, outcome: null })
  })

  it("claims one row, processes it, and reports the outcome", async () => {
    const db = new FakeQueueDb()
    db.reaped = 2
    db.claimable = [queueRow()]

    const summary = await processSourceQueueBatch(db, createDependencies())

    expect(summary).toEqual({
      claimed: 1,
      started: 1,
      released: 0,
      reaped: 2,
      outcome: "succeeded",
    })
    expect(db.succeeded).toEqual([42])
  })
})
