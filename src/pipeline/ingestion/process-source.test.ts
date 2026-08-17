import { afterEach, describe, expect, it, vi } from "vitest"

import {
  deriveIsOutdoorFromParsedEvent,
  deriveRawImageCandidates,
  importParsedSourceEvents,
  sanitizeImagesForIngest,
  type AdminAuditLogInsert,
  type BulkImportResult,
  type CrossSourceCandidateRow,
  type EventSourceRunUpdate,
  type ProcessSourceDb,
  type SourceRunFinalization,
  type SourceRunProgress,
} from "./process-source.js"
import type { EventSourceRow, ParsedEvent } from "./types.js"

// Ported from family-events-backend scrape-source/lib/process-source_test.ts
// (U28), converted from Deno.test to vitest. The supabase client mocks became
// a FakeDb implementing the ProcessSourceDb seam; every scenario and expected
// value is unchanged.

function buildParsedEvent(overrides: Partial<ParsedEvent> = {}): ParsedEvent {
  return {
    title: "Family Story Time",
    description: "Join us at the city library this Saturday.",
    startDatetime: "2026-05-10T14:00:00.000Z",
    endDatetime: null,
    venueName: "Main Library",
    address: "10 Main St",
    sourceUrl: "https://events.example.com/event/story-time",
    imageUrl: null,
    images: [],
    price: null,
    isFree: false,
    ...overrides,
  }
}

describe("deriveIsOutdoorFromParsedEvent", () => {
  it("returns true for outdoor keyword signals", () => {
    const parsed = buildParsedEvent({
      description: "Outdoor meetup in the neighborhood park with a short hike.",
      venueName: "River Walk",
    })
    expect(deriveIsOutdoorFromParsedEvent(parsed)).toBe(true)
  })

  it("returns false for indoor keyword signals", () => {
    const parsed = buildParsedEvent({
      description: "Hands-on museum program inside the library annex.",
    })
    expect(deriveIsOutdoorFromParsedEvent(parsed)).toBe(false)
  })

  it("returns null for conflicting signals", () => {
    const parsed = buildParsedEvent({
      description: "Start at the museum, then head outside to the park playground.",
    })
    expect(deriveIsOutdoorFromParsedEvent(parsed)).toBe(null)
  })
})

describe("deriveRawImageCandidates", () => {
  it("keeps parser-discovered URLs and imageUrl fallback", () => {
    const parsed = buildParsedEvent({
      imageUrl: "https://cdn.example.com/hero.jpg",
      images: [
        "https://cdn.example.com/a.jpg",
        "https://cdn.example.com/a.jpg",
        "javascript:alert(1)",
      ],
    })

    expect(deriveRawImageCandidates(parsed)).toEqual([
      "https://cdn.example.com/a.jpg",
      "https://cdn.example.com/hero.jpg",
    ])
  })

  it("caps candidates at 20", () => {
    const parsed = buildParsedEvent({
      images: Array.from({ length: 25 }, (_, i) => `https://cdn.example.com/${i}.jpg`),
    })

    expect(deriveRawImageCandidates(parsed).length).toBe(20)
  })
})

describe("sanitizeImagesForIngest", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("enforces 2MB size cap and image content-type", async () => {
    vi.stubGlobal("fetch", ((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input : input.url
      )
      if (url.pathname === "/too-big.jpg") {
        return Promise.resolve(
          new Response(null, {
            status: 200,
            headers: {
              "content-type": "image/jpeg",
              "content-length": String(2 * 1024 * 1024 + 1),
            },
          })
        )
      }
      if (url.pathname === "/wrong-type.jpg") {
        return Promise.resolve(
          new Response(null, {
            status: 200,
            headers: { "content-type": "text/html", "content-length": "1024" },
          })
        )
      }
      if (url.pathname === "/ok.jpg") {
        return Promise.resolve(
          new Response(null, {
            status: 200,
            headers: { "content-type": "image/jpeg", "content-length": "1024" },
          })
        )
      }
      if (url.pathname === "/ok-no-length.jpg") {
        if (init?.method === "HEAD") {
          return Promise.resolve(
            new Response(null, {
              status: 200,
              headers: { "content-type": "image/jpeg" },
            })
          )
        }
        return Promise.resolve(
          new Response(new Uint8Array(1024), {
            status: 200,
            headers: { "content-type": "image/jpeg" },
          })
        )
      }
      return Promise.resolve(new Response(null, { status: 404 }))
    }) as typeof fetch)

    const parsed = buildParsedEvent({
      images: [
        "https://events.example.com/too-big.jpg",
        "https://events.example.com/wrong-type.jpg",
        "https://events.example.com/ok.jpg",
        "https://events.example.com/ok-no-length.jpg",
      ],
    })

    const images = await sanitizeImagesForIngest(parsed, "https://events.example.com/feed", {
      // Inject a no-op SSRF resolver so the test exercises the fetch/validation
      // logic without real DNS.
      resolve: () => Promise.resolve({ ok: true }),
    })
    expect(images).toEqual([
      "https://events.example.com/ok.jpg",
      "https://events.example.com/ok-no-length.jpg",
    ])
  })

  it("rejects hosts outside source/config allowlist", async () => {
    let fetchCalls = 0
    vi.stubGlobal("fetch", (() => {
      fetchCalls += 1
      return Promise.resolve(
        new Response(null, {
          status: 200,
          headers: { "content-type": "image/jpeg", "content-length": "1024" },
        })
      )
    }) as typeof fetch)

    const parsed = buildParsedEvent({
      images: ["https://evil.example.net/bad.jpg"],
    })

    const images = await sanitizeImagesForIngest(parsed, "https://events.example.com/feed", {
      resolve: () => Promise.resolve({ ok: true }),
    })
    expect(images).toEqual([])
    expect(fetchCalls).toBe(0)
  })

  it("validates image candidates with bounded concurrency", async () => {
    let active = 0
    let maxActive = 0
    vi.stubGlobal("fetch", (async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 20))
      active -= 1
      return new Response(null, {
        status: 200,
        headers: { "content-type": "image/jpeg", "content-length": "1024" },
      })
    }) as typeof fetch)

    const parsed = buildParsedEvent({
      images: [
        "https://events.example.com/1.jpg",
        "https://events.example.com/2.jpg",
        "https://events.example.com/3.jpg",
        "https://events.example.com/4.jpg",
      ],
    })

    const images = await sanitizeImagesForIngest(parsed, "https://events.example.com/feed", {
      resolve: () => Promise.resolve({ ok: true }),
    })
    expect(images.length).toBe(4)
    expect(maxActive).toBe(2)
  })
})

/**
 * Builds a minimal EventSourceRow for import-path tests.
 * consecutive_zero_result_scrapes defaults to 0, stale_escalated_at to null.
 */
function buildSource(overrides: Partial<EventSourceRow> = {}): EventSourceRow {
  return {
    id: "src-1",
    name: "Test Source",
    url: "https://events.example.com/feed",
    source_type: "rss",
    extraction_mode: "deterministic",
    processing_mode: null,
    city_id: null,
    is_active: true,
    auto_approve: false,
    scrape_interval_hours: 24,
    last_scraped_at: null,
    last_status: "success",
    error_count: 0,
    date_window_days: null,
    consecutive_zero_result_scrapes: 0,
    stale_escalated_at: null,
    ...overrides,
  }
}

/**
 * Fake ProcessSourceDb mirroring the upstream supabase client mocks: captures
 * writes per table, lets tests control candidate/bulk responses, and throws
 * where the pg-backed repository would throw.
 */
class FakeDb implements ProcessSourceDb {
  cityTimezone = "UTC"
  cityCentroid: { latitude: number | null; longitude: number | null } | null = null

  crossSourceCandidates: CrossSourceCandidateRow[] = []
  crossSourceCandidateError: (Error & { code?: string }) | null = null
  crossSourceCalls: Array<{ cityId: string; startFrom: string; startTo: string; limit: number }> =
    []

  bulkCalls: Record<string, unknown>[][] = []
  bulkResult: BulkImportResult = { imported: 0, updated: 0, skipped: 0, enqueued: 0 }
  /** When true, mimic upstream FakeSupabase: imported = events.length. */
  bulkResultFromEvents = false
  bulkError: Error | null = null

  progressUpdates: SourceRunProgress[] = []
  finalizations: SourceRunFinalization[] = []
  finalizeError: Error | null = null

  eventSourceUpdates: EventSourceRunUpdate[] = []
  eventSourceUpdateError: Error | null = null

  auditInserts: AdminAuditLogInsert[] = []
  auditInsertError: Error | null = null

  tagQueueKicks = 0

  get lastEventSourceUpdate(): EventSourceRunUpdate | undefined {
    return this.eventSourceUpdates[this.eventSourceUpdates.length - 1]
  }

  async resolveCityTimezone(): Promise<string> {
    return this.cityTimezone
  }

  async fetchCityCentroid(): Promise<{
    latitude: number | null
    longitude: number | null
  } | null> {
    return this.cityCentroid
  }

  async updateSourceRunProgress(_runId: string, progress: SourceRunProgress): Promise<void> {
    this.progressUpdates.push(progress)
  }

  async findCrossSourceEventCandidates(args: {
    cityId: string
    startFrom: string
    startTo: string
    limit: number
  }): Promise<CrossSourceCandidateRow[]> {
    this.crossSourceCalls.push(args)
    if (this.crossSourceCandidateError) throw this.crossSourceCandidateError
    return this.crossSourceCandidates
  }

  async bulkImportScrapeEvents(
    _runId: string,
    _sourceId: string,
    events: Record<string, unknown>[]
  ): Promise<BulkImportResult | null> {
    this.bulkCalls.push(events)
    if (this.bulkError) throw this.bulkError
    if (this.bulkResultFromEvents) {
      return { imported: events.length, updated: 0, skipped: 0, enqueued: events.length }
    }
    return this.bulkResult
  }

  async finalizeSourceRun(_runId: string, finalization: SourceRunFinalization): Promise<void> {
    this.finalizations.push(finalization)
    if (this.finalizeError) throw this.finalizeError
  }

  async updateEventSourceAfterRun(_sourceId: string, update: EventSourceRunUpdate): Promise<void> {
    this.eventSourceUpdates.push(update)
    if (this.eventSourceUpdateError) throw this.eventSourceUpdateError
  }

  async insertAdminAuditLog(row: AdminAuditLogInsert): Promise<void> {
    this.auditInserts.push(row)
    if (this.auditInsertError) throw this.auditInsertError
  }

  async invokeProcessTagQueue(): Promise<void> {
    this.tagQueueKicks += 1
  }
}

describe("stale escalation", () => {
  it("3 consecutive zero-result scrapes triggers stale status and audit log", async () => {
    // Source has already seen 2 consecutive zero-result scrapes.
    const source = buildSource({ consecutive_zero_result_scrapes: 2, stale_escalated_at: null })
    const db = new FakeDb()

    // Pass 0 parsedEvents → eventsFound=0 → zero-result success path.
    await importParsedSourceEvents(db, source, "run-1", [])

    // event_sources update should set last_status='stale', consecutive=3, stale_escalated_at set.
    const update = db.lastEventSourceUpdate
    expect(update, "event_sources update was not called").toBeDefined()
    expect(update?.last_status).toBe("stale")
    expect(update?.consecutive_zero_result_scrapes).toBe(3)
    expect(update?.stale_escalated_at, "stale_escalated_at should be set").toBeDefined()

    // admin_audit_log insert should have been fired once.
    expect(db.auditInserts.length).toBe(1)
    const auditRow = db.auditInserts[0]
    expect(auditRow?.action).toBe("source.stale_escalated")
    expect(auditRow?.target_type).toBe("event_source")
    expect(auditRow?.target_id).toBe("src-1")
    expect(auditRow?.admin_user_id).toBe(null)
  })

  it("non-zero import resets consecutive_zero_result_scrapes to 0", async () => {
    const source = buildSource({ consecutive_zero_result_scrapes: 2, stale_escalated_at: null })
    const db = new FakeDb()
    // 1 event imported → eventsImported > 0 → not a zero-result run.
    db.bulkResult = { imported: 1, updated: 0, skipped: 0, enqueued: 1 }

    await importParsedSourceEvents(db, source, "run-2", [buildParsedEvent()])

    const update = db.lastEventSourceUpdate
    expect(update, "event_sources update was not called").toBeDefined()
    expect(update?.consecutive_zero_result_scrapes).toBe(0)
    expect(update?.last_status).toBe("success")
    // stale_escalated_at should NOT be set (no escalation).
    expect(
      update?.stale_escalated_at,
      "stale_escalated_at should not be set when events are imported"
    ).toBeUndefined()
    // No audit log entry.
    expect(db.auditInserts.length).toBe(0)
  })

  it("already-escalated source does not re-alert or overwrite timestamp", async () => {
    const existingTimestamp = "2026-06-19T00:00:00.000Z"
    const source = buildSource({
      consecutive_zero_result_scrapes: 5,
      stale_escalated_at: existingTimestamp,
    })
    const db = new FakeDb()

    await importParsedSourceEvents(db, source, "run-3", [])

    const update = db.lastEventSourceUpdate
    expect(update, "event_sources update was not called").toBeDefined()
    // consecutive counter still increments (tracking), but no re-escalation.
    expect(update?.consecutive_zero_result_scrapes).toBe(6)
    // last_status stays "success" (zero-result, no events found — not re-escalated).
    expect(update?.last_status).toBe("success")
    // stale_escalated_at NOT in the update payload (idempotent).
    expect(
      update?.stale_escalated_at,
      "stale_escalated_at should not be overwritten on already-escalated source"
    ).toBeUndefined()
    // No second audit log entry.
    expect(db.auditInserts.length).toBe(0)
  })

  it("audit-log insert error stays non-fatal and still escalates", async () => {
    const source = buildSource({ consecutive_zero_result_scrapes: 2, stale_escalated_at: null })
    const db = new FakeDb()
    // admin_audit_log insert throws (RLS/constraint) — must not break finalization.
    db.auditInsertError = new Error("permission denied for table admin_audit_log")

    // Must not throw even though the audit write fails.
    await importParsedSourceEvents(db, source, "run-4", [])

    // Escalation still happened on event_sources despite the audit failure.
    const update = db.lastEventSourceUpdate
    expect(update, "event_sources update was not called").toBeDefined()
    expect(update?.last_status).toBe("stale")
    expect(update?.consecutive_zero_result_scrapes).toBe(3)
    // Insert was attempted exactly once.
    expect(db.auditInserts.length).toBe(1)
  })

  it("three consecutive empty successes increment to the threshold", async () => {
    for (const consecutiveZeroBeforeRun of [0, 1, 2]) {
      const db = new FakeDb()
      const result = await importParsedSourceEvents(
        db,
        buildSource({ consecutive_zero_result_scrapes: consecutiveZeroBeforeRun }),
        `run-empty-${consecutiveZeroBeforeRun}`,
        []
      )

      expect(result.status).toBe("success")
      expect(db.lastEventSourceUpdate?.consecutive_zero_result_scrapes).toBe(
        consecutiveZeroBeforeRun + 1
      )
      if (consecutiveZeroBeforeRun === 2) {
        expect(db.lastEventSourceUpdate?.last_status).toBe("stale")
        expect(db.auditInserts.length).toBe(1)
      }
    }
  })
})

describe("finalization", () => {
  it("source_runs update error makes a successful scrape retryable", async () => {
    const db = new FakeDb()
    db.finalizeError = new Error("source_runs update denied")

    const result = await importParsedSourceEvents(db, buildSource(), "run-source-runs-error", [])

    expect(result.status).toBe("error")
    expect(result.error?.includes("source_runs write")).toBe(true)
  })

  it("event_sources update error makes a successful scrape retryable", async () => {
    const db = new FakeDb()
    db.eventSourceUpdateError = new Error("event_sources update denied")

    const result = await importParsedSourceEvents(db, buildSource(), "run-event-sources-error", [])

    expect(result.status).toBe("error")
    expect(result.error?.includes("event_sources write")).toBe(true)
  })

  it("event_sources update error makes a partial scrape retryable", async () => {
    const db = new FakeDb()
    db.bulkResult = { imported: 0, updated: 0, skipped: 0, enqueued: 0 }
    db.eventSourceUpdateError = new Error("event_sources update denied")

    const result = await importParsedSourceEvents(
      db,
      buildSource(),
      "run-event-sources-partial-error",
      [buildParsedEvent()]
    )

    expect(result.status).toBe("error")
    expect(result.error?.includes("event_sources write")).toBe(true)
  })

  it("concurrent write errors preserve the source_runs failure first", async () => {
    const db = new FakeDb()
    db.finalizeError = new Error("source_runs update denied")
    db.eventSourceUpdateError = new Error("event_sources update denied")

    const result = await importParsedSourceEvents(
      db,
      buildSource(),
      "run-both-finalization-errors",
      []
    )

    expect(result.status).toBe("error")
    expect(result.error?.includes("source_runs write")).toBe(true)
  })

  it("write errors do not replace the original scrape failure", async () => {
    const db = new FakeDb()
    db.bulkError = new Error("original scrape failed")
    db.eventSourceUpdateError = new Error("event_sources update denied")

    const result = await importParsedSourceEvents(db, buildSource(), "run-original-error", [
      buildParsedEvent(),
    ])

    expect(result.status).toBe("error")
    expect(result.error).toBe("original scrape failed")
  })
})

// ── importParsedSourceEvents: cross-source dedup pre-pass ─────────────────

function buildDedupSource(overrides: Partial<EventSourceRow> = {}): EventSourceRow {
  return buildSource({
    id: "source-a",
    name: "Test Source A",
    url: "https://example.com/feed",
    city_id: "city-1",
    last_status: null,
    ...overrides,
  })
}

function buildParsedEventForDedup(overrides: Partial<ParsedEvent> = {}): ParsedEvent {
  return buildParsedEvent({
    title: "Family Story Time",
    description: "A fun event for kids",
    startDatetime: "2026-06-20T14:00:00.000Z",
    venueName: "City Library",
    address: "100 Main St",
    sourceUrl: "https://example.com/event/1",
    isFree: true,
    price: null,
    ...overrides,
  })
}

function buildDedupDb(): FakeDb {
  const db = new FakeDb()
  db.cityCentroid = { latitude: 30.45, longitude: -91.19 }
  db.bulkResultFromEvents = true
  return db
}

describe("importParsedSourceEvents: cross-source dedup pre-pass", () => {
  it("cross-source fuzzy duplicate within four hours is skipped", async () => {
    const db = buildDedupDb()
    // Existing event from a DIFFERENT source with the same title within two hours.
    db.crossSourceCandidates = [
      {
        id: "event-existing-1",
        title: "Family Story Time",
        source_id: "source-b",
        start_datetime: "2026-06-20T16:00:00.000Z",
      },
    ]

    const source = buildDedupSource({ id: "source-a", city_id: "city-1" })
    const parsedEvents = [buildParsedEventForDedup()]

    const result = await importParsedSourceEvents(db, source, "run-1", parsedEvents)

    // The event must have been skipped — bulk_import called with empty array
    expect(db.bulkCalls.length).toBe(1)
    expect(db.bulkCalls[0]?.length).toBe(0)
    // eventsSkipped should reflect the cross-source skip
    expect(result.eventsSkipped).toBe(1)
  })

  it("recurring title outside the four-hour window is imported", async () => {
    const db = buildDedupDb()
    db.crossSourceCandidates = [
      {
        id: "event-last-week",
        title: "Family Story Time",
        source_id: "source-b",
        start_datetime: "2026-06-13T14:00:00.000Z",
      },
    ]

    await importParsedSourceEvents(db, buildDedupSource(), "run-recurring", [
      buildParsedEventForDedup(),
    ])

    expect(db.bulkCalls[0]?.length).toBe(1)
  })

  it("requests 1000 candidates and dedupes a match beyond the old cap", async () => {
    const db = buildDedupDb()
    db.crossSourceCandidates = [
      ...Array.from({ length: 500 }, (_, index) => ({
        id: `event-no-match-${index}`,
        title: `Different Event ${index}`,
        source_id: "source-b",
        start_datetime: "2026-06-20T14:00:00.000Z",
      })),
      {
        id: "event-beyond-old-cap",
        title: "Family Story Time",
        source_id: "source-b",
        start_datetime: "2026-06-20T14:00:00.000Z",
      },
    ]

    await importParsedSourceEvents(db, buildDedupSource(), "run-cap", [buildParsedEventForDedup()])

    expect(db.crossSourceCalls[0]?.limit).toBe(1000)
    expect(db.bulkCalls[0]?.length).toBe(0)
  })

  it("warns once when the candidate cap is reached", async () => {
    const db = buildDedupDb()
    db.crossSourceCandidates = Array.from({ length: 1000 }, (_, index) => ({
      id: `event-${index}`,
      title: `Different Event ${index}`,
      source_id: "source-b",
      start_datetime: "2026-06-20T14:00:00.000Z",
    }))
    const warnings: string[] = []
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((message: string) => {
      warnings.push(message)
    })

    try {
      await importParsedSourceEvents(db, buildDedupSource(), "run-cap-warning", [
        buildParsedEventForDedup(),
      ])
    } finally {
      warnSpy.mockRestore()
    }

    const capWarnings = warnings.filter((message) =>
      message.includes("cross-source dedup candidate cap reached")
    )
    expect(capWarnings.length).toBe(1)
    expect(JSON.parse(capWarnings[0] ?? "{}").source_id).toBe("source-a")
    expect(JSON.parse(capWarnings[0] ?? "{}").candidate_count).toBe(1000)
  })

  it("same-source candidate is NOT skipped", async () => {
    const db = buildDedupDb()
    // Candidate from the SAME source — should not be filtered by dedup
    db.crossSourceCandidates = [
      {
        id: "event-existing-2",
        title: "Family Story Time",
        source_id: "source-a", // same source
        start_datetime: "2026-06-20T14:00:00.000Z",
      },
    ]

    const source = buildDedupSource({ id: "source-a", city_id: "city-1" })
    const parsedEvents = [buildParsedEventForDedup()]

    await importParsedSourceEvents(db, source, "run-2", parsedEvents)

    // Not filtered by dedup — must be passed to bulk_import
    expect(db.bulkCalls.length).toBe(1)
    expect(db.bulkCalls[0]?.length).toBe(1)
  })

  it("city_id null bypasses dedup entirely", async () => {
    const db = buildDedupDb()
    // Even with cross-source candidates configured, dedup should not run
    db.crossSourceCandidates = [
      {
        id: "event-existing-3",
        title: "Family Story Time",
        source_id: "source-b",
        start_datetime: "2026-06-20T14:00:00.000Z",
      },
    ]

    const source = buildDedupSource({ id: "source-a", city_id: null })
    const parsedEvents = [buildParsedEventForDedup()]

    await importParsedSourceEvents(db, source, "run-3", parsedEvents)

    // All events passed through — dedup skipped when city_id is null
    expect(db.crossSourceCalls.length).toBe(0)
    expect(db.bulkCalls.length).toBe(1)
    expect(db.bulkCalls[0]?.length).toBe(1)
  })

  it("dedup RPC missing (42883) does not break ingestion", async () => {
    const db = buildDedupDb()
    const missing = new Error("function not found") as Error & { code?: string }
    missing.code = "42883"
    db.crossSourceCandidateError = missing

    const source = buildDedupSource({ id: "source-a", city_id: "city-1" })
    const parsedEvents = [buildParsedEventForDedup()]

    const result = await importParsedSourceEvents(db, source, "run-4", parsedEvents)

    // Ingestion must still succeed (status = success, event imported)
    expect(result.status).toBe("success")
    expect(db.bulkCalls.length).toBe(1)
    expect(db.bulkCalls[0]?.length).toBe(1)
  })
})
