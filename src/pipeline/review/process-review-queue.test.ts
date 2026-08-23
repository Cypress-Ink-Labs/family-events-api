import { describe, expect, it, vi } from "vitest"

import {
  processReviewQueueBatch,
  type EventLlmReviewQueueRow,
  type EventReviewRow,
  type ReviewQueueBatchSummary,
  type ReviewQueueDb,
  type ReviewQueueWorkerDependencies,
} from "./process-review-queue.js"
import {
  LLM_EVENT_REVIEW_DECISION,
  LLM_EVENT_REVIEW_STATUS,
  type AppliedLlmEventReviewDecision,
  type LlmEventReviewDecision,
  type LlmReviewConfig,
} from "./event-review/index.js"

class FakeReviewQueueDb implements ReviewQueueDb {
  reaped = 0
  claimedRows: EventLlmReviewQueueRow[] = []
  events = new Map<string, EventReviewRow>()
  startedAttempts = new Map<number, number>()
  featureFlags = new Map<string, boolean>()
  autoRejectedSources = new Set<string>()
  sourceCheckCalls: string[] = []
  traces: Array<{ status: string; eventId: string }> = []
  standaloneTraceInsertError: Error | null = null
  applyEventDecisionError: Error | null = null
  updates = new Map<number, Record<string, unknown>>()
  releaseCalls: number[][] = []

  async reapStuckReviewQueueRows(): Promise<number> {
    return this.reaped
  }

  async claimReviewQueueBatch(limit: number): Promise<EventLlmReviewQueueRow[]> {
    return this.claimedRows.slice(0, limit)
  }

  async markReviewQueueRowStarted(queueId: number): Promise<EventLlmReviewQueueRow> {
    const claimedRow = this.claimedRows.find((candidate) => candidate.id === queueId)
    if (!claimedRow) throw new Error("queue row missing")
    return {
      ...claimedRow,
      attempt_count: this.startedAttempts.get(queueId) ?? claimedRow.attempt_count + 1,
    }
  }

  async releaseUnstartedReviewQueueRows(claimedIds: number[]): Promise<void> {
    this.releaseCalls.push(claimedIds)
  }

  async markReviewQueueRowSucceeded(queueId: number): Promise<void> {
    this.updates.set(queueId, { status: "succeeded" })
  }

  async markReviewQueueRowDead(queueId: number, error: string): Promise<void> {
    this.updates.set(queueId, { status: "dead", error })
  }

  async scheduleReviewQueueRetry(
    queueId: number,
    nextAttemptAt: string,
    error: string
  ): Promise<void> {
    this.updates.set(queueId, { status: "retrying", nextAttemptAt, error })
  }

  async loadReviewEvent(eventId: string): Promise<EventReviewRow | null> {
    return this.events.get(eventId) ?? null
  }

  async insertReviewTrace(
    params: Parameters<ReviewQueueDb["insertReviewTrace"]>[0]
  ): Promise<void> {
    if (this.standaloneTraceInsertError) throw this.standaloneTraceInsertError
    this.traces.push({ status: params.status, eventId: params.eventId })
  }

  async applyEventDecision(
    params: Parameters<ReviewQueueDb["applyEventDecision"]>[0]
  ): Promise<boolean> {
    if (this.applyEventDecisionError) throw this.applyEventDecisionError
    const loadedEvent = this.events.get(params.event.id)
    if (!loadedEvent || loadedEvent.status !== "draft") return false
    this.updates.set(params.queueRow.id, { status: "succeeded" })
    this.traces.push({
      status: params.review.status === LLM_EVENT_REVIEW_STATUS.FAILED ? "failed" : "succeeded",
      eventId: params.event.id,
    })
    return true
  }

  async shouldAutoRejectSource(sourceId: string): Promise<boolean> {
    this.sourceCheckCalls.push(sourceId)
    return this.autoRejectedSources.has(sourceId)
  }

  async fetchEventEmbedding(_eventId: string): Promise<string | null> {
    return null
  }

  async fetchEventCityId(_eventId: string): Promise<string | null> {
    return null
  }

  async getMemoryFeatureFlag(feature: "tag-memory" | "review-memory" | "source-auto-reject") {
    const enabled = this.featureFlags.get(feature)
    return enabled === undefined ? null : { enabled }
  }

  async findSimilarEvents(): Promise<[]> {
    return []
  }

  async fetchEventTagsForEvents(): Promise<[]> {
    return []
  }

  async fetchTagDecisionsForEvents(): Promise<[]> {
    return []
  }

  async fetchReviewEventsByIds(): Promise<[]> {
    return []
  }

  async fetchStatusDecisionsForEvents(): Promise<[]> {
    return []
  }
}

function config(overrides: Partial<LlmReviewConfig> = {}): LlmReviewConfig {
  return {
    enabled: true,
    provider: "openai-compatible",
    baseUrl: "https://example.com/v1",
    model: "model-x",
    apiKey: "test-key",
    promptVersion: "event-review-v1",
    confidenceThreshold: 0.75,
    timeoutMs: 30_000,
    maxAttempts: 3,
    retryBaseMs: 60_000,
    persistRawResponse: false,
    valid: true,
    invalidReason: null,
    ...overrides,
  }
}

function event(id: string, overrides: Partial<EventReviewRow> = {}): EventReviewRow {
  return {
    id,
    status: "draft",
    title: "Family Story Time",
    description: "Books and songs",
    start_datetime: "2026-06-01T14:00:00Z",
    end_datetime: null,
    timezone: "America/Chicago",
    venue_name: "Library",
    address: "10 Main St",
    source_name: "Library feed",
    source_url: "https://example.com/events/1",
    llm_review_status: "pending",
    llm_review_decision: null,
    ...overrides,
  }
}

function row(id: number, overrides: Partial<EventLlmReviewQueueRow> = {}): EventLlmReviewQueueRow {
  return {
    id,
    event_id: `event-${id}`,
    source_id: null,
    source_run_id: `run-${id}`,
    trigger_type: "import",
    status: "pending",
    attempt_count: 0,
    max_attempts: 3,
    next_attempt_at: "2026-06-01T00:00:00Z",
    ...overrides,
  }
}

function decision(
  appliedDecision: LlmEventReviewDecision = LLM_EVENT_REVIEW_DECISION.APPROVE,
  overrides: Partial<AppliedLlmEventReviewDecision> = {}
): AppliedLlmEventReviewDecision {
  return {
    status: LLM_EVENT_REVIEW_STATUS.SUCCEEDED,
    modelDecision: appliedDecision,
    appliedDecision,
    confidence: 0.91,
    reason: "Clear family event",
    flags: [],
    suggestedCategory: null,
    normalizedTitle: null,
    provider: "openai-compatible",
    model: "model-x",
    promptVersion: "event-review-v1",
    rawResponse: null,
    errorCode: null,
    errorMessage: null,
    processingMs: 10,
    ...overrides,
  }
}

async function runBatch(
  db: FakeReviewQueueDb,
  dependencies: Partial<ReviewQueueWorkerDependencies> = {}
): Promise<ReviewQueueBatchSummary> {
  return processReviewQueueBatch(db, { config: config(), ...dependencies })
}

describe("processReviewQueueBatch", () => {
  it("counts approve, reject, and needs-admin-review decisions", async () => {
    const db = new FakeReviewQueueDb()
    db.claimedRows = [row(1), row(2), row(3)]
    for (const item of db.claimedRows) db.events.set(item.event_id, event(item.event_id))

    const decisions = [
      LLM_EVENT_REVIEW_DECISION.APPROVE,
      LLM_EVENT_REVIEW_DECISION.REJECT,
      LLM_EVENT_REVIEW_DECISION.NEEDS_ADMIN_REVIEW,
    ] as const
    const summary = await runBatch(db, {
      reviewEvent: async (input) => decision(decisions[Number(input.eventId.at(-1)) - 1]!),
    })

    expect(summary).toEqual({
      claimed: 3,
      reaped: 0,
      succeeded: 3,
      failed: 0,
      retrying: 0,
      dead: 0,
      approved: 1,
      rejected: 1,
      needsAdminReview: 1,
    })
    expect(db.traces).toEqual([
      { status: "succeeded", eventId: "event-1" },
      { status: "succeeded", eventId: "event-2" },
      { status: "succeeded", eventId: "event-3" },
    ])
  })

  it("releases only the unstarted suffix when the wall budget expires", async () => {
    const db = new FakeReviewQueueDb()
    db.claimedRows = [row(1), row(2), row(3), row(4)]
    for (const item of db.claimedRows) db.events.set(item.event_id, event(item.event_id))
    const clock = [0, 0, 110_000]
    let index = 0

    const summary = await runBatch(db, {
      now: () => clock[Math.min(index++, clock.length - 1)]!,
      reviewEvent: async () => decision(),
    })

    expect(summary.succeeded).toBe(3)
    expect(db.releaseCalls).toEqual([[4]])
  })

  it("does not retry an already-applied decision when standalone trace insertion fails", async () => {
    const db = new FakeReviewQueueDb()
    db.claimedRows = [row(1)]
    db.events.set("event-1", event("event-1"))
    db.standaloneTraceInsertError = new Error("standalone trace insert should not run")

    const summary = await runBatch(db, { reviewEvent: async () => decision() })

    expect(summary.succeeded).toBe(1)
    expect(summary.retrying).toBe(0)
    expect(summary.dead).toBe(0)
    expect(db.updates.get(1)?.status).toBe("succeeded")
    expect(db.traces).toEqual([{ status: "succeeded", eventId: "event-1" }])
  })

  it("skips a non-reviewable event without calling the LLM", async () => {
    const db = new FakeReviewQueueDb()
    db.claimedRows = [row(1)]
    db.events.set("event-1", event("event-1", { status: "published" }))
    let reviewCalls = 0

    const summary = await runBatch(db, {
      reviewEvent: async () => {
        reviewCalls += 1
        return decision()
      },
    })

    expect(summary.succeeded).toBe(1)
    expect(reviewCalls).toBe(0)
    expect(db.updates.get(1)?.status).toBe("succeeded")
    expect(db.traces).toEqual([{ status: "skipped", eventId: "event-1" }])
  })

  it("auto-rejects without calling the LLM when the source-auto-reject feature flag is enabled", async () => {
    const db = new FakeReviewQueueDb()
    db.claimedRows = [row(1, { source_id: "source-1" })]
    for (const item of db.claimedRows) db.events.set(item.event_id, event(item.event_id))
    db.featureFlags.set("source-auto-reject", true)
    db.autoRejectedSources.add("source-1")
    let reviewCalls = 0

    const summary = await runBatch(db, {
      reviewEvent: async () => {
        reviewCalls += 1
        return decision()
      },
    })

    expect(summary.rejected).toBe(1)
    expect(reviewCalls).toBe(0)
    expect(db.sourceCheckCalls).toEqual(["source-1"])
    expect(db.traces).toEqual([{ status: "succeeded", eventId: "event-1" }])
  })

  it("retries an auto-reject apply failure without falling through to the LLM", async () => {
    const db = new FakeReviewQueueDb()
    db.claimedRows = [row(1, { source_id: "source-1" })]
    db.events.set("event-1", event("event-1"))
    db.featureFlags.set("source-auto-reject", true)
    db.autoRejectedSources.add("source-1")
    db.applyEventDecisionError = new Error("apply unavailable")
    let reviewCalls = 0

    const summary = await runBatch(db, {
      reviewEvent: async () => {
        reviewCalls += 1
        return decision()
      },
    })

    expect(reviewCalls).toBe(0)
    expect(summary.retrying).toBe(1)
    expect(summary.dead).toBe(0)
    expect(db.updates.get(1)?.status).toBe("retrying")
  })

  it("calls the LLM and skips the source lookup when source-auto-reject is disabled", async () => {
    const db = new FakeReviewQueueDb()
    db.claimedRows = [row(1, { source_id: "source-1" })]
    db.events.set("event-1", event("event-1"))
    db.autoRejectedSources.add("source-1")
    let reviewCalls = 0

    const summary = await runBatch(db, {
      reviewEvent: async () => {
        reviewCalls += 1
        return decision()
      },
    })

    expect(summary.approved).toBe(1)
    expect(reviewCalls).toBe(1)
    expect(db.sourceCheckCalls).toEqual([])
  })

  it("does not retry a successful apply when post-apply telemetry throws", async () => {
    const db = new FakeReviewQueueDb()
    db.claimedRows = [row(1)]
    db.events.set("event-1", event("event-1"))
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation((message) => {
      if (String(message).includes("event_review_provider_failed")) {
        throw new Error("telemetry unavailable")
      }
    })

    try {
      const summary = await runBatch(db, {
        reviewEvent: async () =>
          decision(LLM_EVENT_REVIEW_DECISION.NEEDS_ADMIN_REVIEW, {
            status: LLM_EVENT_REVIEW_STATUS.FAILED,
            modelDecision: null,
            errorCode: "provider_error",
            errorMessage: "provider unavailable",
          }),
      })

      expect(summary).toMatchObject({ succeeded: 1, failed: 1, retrying: 0, dead: 0 })
      expect(db.updates.get(1)?.status).toBe("succeeded")
      expect(db.traces).toEqual([{ status: "failed", eventId: "event-1" }])
    } finally {
      consoleWarn.mockRestore()
    }
  })

  it("records a failed trace and routes thrown LLM errors through retry then dead-letter", async () => {
    const db = new FakeReviewQueueDb()
    db.claimedRows = [row(1), row(2, { max_attempts: 1 })]
    for (const item of db.claimedRows) db.events.set(item.event_id, event(item.event_id))

    const summary = await runBatch(db, {
      reviewEvent: async () => {
        throw new Error("provider unavailable")
      },
    })

    expect(summary.failed).toBe(2)
    expect(summary.retrying).toBe(1)
    expect(summary.dead).toBe(1)
    expect(db.updates.get(1)?.status).toBe("retrying")
    expect(db.updates.get(2)?.status).toBe("dead")
    expect(db.traces).toEqual([
      { status: "failed", eventId: "event-1" },
      { status: "failed", eventId: "event-2" },
    ])
  })
})
