// Review-queue batch worker: reaps stuck rows, claims a bounded batch, runs
// LLM review with bounded concurrency, retries transient failures, and
// releases unstarted work before the invocation budget expires.
// Ported from family-events-backend/supabase/functions/process-event-review-queue/lib/worker.ts (U29).
// The Supabase client becomes the narrow ReviewQueueDb seam; repository and
// pg-boss registration remain separate work.

import { errorMessage, logEdgeEvent } from "../logger.js"
import {
  fetchSimilarReviewContext,
  formatReviewMemoryPrompt,
  isMemoryFeatureEnabled,
  type MemoryContextDb,
} from "../memory-context.js"
import {
  LLM_EVENT_REVIEW_DECISION,
  LLM_EVENT_REVIEW_STATUS,
  reviewEventWithLlm,
  type AppliedLlmEventReviewDecision,
  type LlmEventReviewDecision,
  type LlmReviewConfig,
  type ReviewMemoryContext,
} from "./event-review/index.js"

const DEFAULT_BATCH_SIZE = 60
const MAX_BATCH_SIZE = 100
const BUDGET_MS = 110_000
const REVIEW_CONCURRENCY = 3
const REVIEWABLE_LLM_REVIEW_STATUS_PENDING = "pending"

export interface EventLlmReviewQueueRow {
  id: number
  event_id: string
  source_id: string | null
  source_run_id: string | null
  trigger_type: string
  status: "pending" | "processing" | "retrying" | "succeeded" | "dead"
  attempt_count: number
  max_attempts: number
  next_attempt_at: string
}

export interface EventReviewRow {
  id: string
  status: "draft" | "published" | "rejected" | "archived"
  title: string
  description: string | null
  start_datetime: string
  end_datetime: string | null
  timezone: string | null
  venue_name: string | null
  address: string | null
  source_name: string | null
  source_url: string | null
  llm_review_status: string
  llm_review_decision: string | null
}

export interface ReviewTraceInsert {
  queueRow: EventLlmReviewQueueRow
  eventId: string
  review: AppliedLlmEventReviewDecision
  modelDecision: LlmEventReviewDecision | null
  inputSnapshot: Record<string, unknown>
  status: "succeeded" | "failed" | "skipped"
}

export interface ApplyEventDecisionInput {
  event: EventReviewRow
  queueRow: EventLlmReviewQueueRow
  review: AppliedLlmEventReviewDecision
}

/**
 * Queue-side DB operations the legacy Supabase RPCs and queries covered.
 * The review-memory methods are inherited so every lookup stays behind this
 * seam; a later repository implementation supplies the pg queries.
 */
export interface ReviewQueueDb extends MemoryContextDb {
  reapStuckReviewQueueRows(): Promise<number>
  claimReviewQueueBatch(limit: number): Promise<EventLlmReviewQueueRow[]>
  markReviewQueueRowStarted(queueId: number): Promise<EventLlmReviewQueueRow>
  releaseUnstartedReviewQueueRows(claimedIds: number[]): Promise<void>
  markReviewQueueRowSucceeded(queueId: number): Promise<void>
  markReviewQueueRowDead(queueId: number, error: string): Promise<void>
  scheduleReviewQueueRetry(queueId: number, nextAttemptAt: string, error: string): Promise<void>
  loadReviewEvent(eventId: string): Promise<EventReviewRow | null>
  insertReviewTrace(params: ReviewTraceInsert): Promise<void>
  applyEventDecision(params: ApplyEventDecisionInput): Promise<boolean>
  shouldAutoRejectSource(sourceId: string): Promise<boolean>
  /** event_embeddings.embedding lookup for review-memory prompt construction. */
  fetchEventEmbedding(eventId: string): Promise<string | null>
  /** events.city_id lookup for review-memory similarity scoping. */
  fetchEventCityId(eventId: string): Promise<string | null>
}

export interface ReviewQueueWorkerDependencies {
  config: LlmReviewConfig
  /** Defaults to 60 and is clamped to the legacy maximum of 100. */
  batchSize?: number
  now?: () => number
  reviewEvent?: typeof reviewEventWithLlm
}

export interface ReviewQueueBatchSummary {
  claimed: number
  reaped: number
  succeeded: number
  failed: number
  retrying: number
  dead: number
  approved: number
  rejected: number
  needsAdminReview: number
}

interface EventReviewQueueRowResult {
  outcome: "succeeded" | "retrying" | "dead" | "skipped"
  appliedDecision: LlmEventReviewDecision | null
  failed: boolean
}

function resolveBatchSize(batchSize: number | undefined): number {
  if (!Number.isFinite(batchSize)) return DEFAULT_BATCH_SIZE
  return Math.max(1, Math.min(Math.floor(batchSize!), MAX_BATCH_SIZE))
}

function shouldStopBeforeStartingNextRow(elapsedMs: number): boolean {
  return elapsedMs >= BUDGET_MS
}

function backoffMs(attemptCount: number, baseMs: number): number {
  return baseMs * Math.pow(2, Math.max(0, attemptCount - 1))
}

function traceInputSnapshot(event: EventReviewRow): Record<string, unknown> {
  return {
    title: event.title,
    start_datetime: event.start_datetime,
    source_name: event.source_name,
    source_url: event.source_url,
  }
}

function buildSkippedReview(reason: string, promptVersion: string): AppliedLlmEventReviewDecision {
  return {
    status: LLM_EVENT_REVIEW_STATUS.FAILED,
    modelDecision: null,
    appliedDecision: LLM_EVENT_REVIEW_DECISION.NEEDS_ADMIN_REVIEW,
    confidence: null,
    reason,
    flags: ["skipped"],
    suggestedCategory: null,
    normalizedTitle: null,
    provider: null,
    model: null,
    promptVersion,
    rawResponse: null,
    errorCode: "skipped",
    errorMessage: reason,
    processingMs: 0,
  }
}

function buildFailedReview(reason: string, promptVersion: string): AppliedLlmEventReviewDecision {
  return {
    ...buildSkippedReview(reason, promptVersion),
    flags: ["worker_error"],
    errorCode: "worker_error",
  }
}

function isReviewable(event: EventReviewRow): boolean {
  return (
    event.status === "draft" &&
    (event.llm_review_status === REVIEWABLE_LLM_REVIEW_STATUS_PENDING ||
      event.llm_review_status === LLM_EVENT_REVIEW_STATUS.NOT_REQUIRED)
  )
}

function buildReviewInput(event: EventReviewRow) {
  return {
    eventId: event.id,
    title: event.title,
    description: event.description,
    startDatetime: event.start_datetime,
    endDatetime: event.end_datetime,
    timezone: event.timezone,
    venueName: event.venue_name,
    address: event.address,
    sourceName: event.source_name,
    sourceUrl: event.source_url,
    category: null,
    tags: [],
  }
}

async function fetchReviewMemory(
  db: ReviewQueueDb,
  eventId: string
): Promise<ReviewMemoryContext | null> {
  try {
    if (!(await isMemoryFeatureEnabled(db, "review-memory"))) return null

    const embeddingRaw = await db.fetchEventEmbedding(eventId)
    if (!embeddingRaw) return null
    const embedding = JSON.parse(embeddingRaw) as unknown
    if (!Array.isArray(embedding) || embedding.length === 0) return null
    if (!embedding.every((value) => typeof value === "number" && Number.isFinite(value)))
      return null

    const { contexts, confidenceAdjustment } = await fetchSimilarReviewContext(
      db,
      embedding,
      eventId,
      await db.fetchEventCityId(eventId),
      5
    )
    if (contexts.length === 0) return null

    return {
      memoryPrompt: formatReviewMemoryPrompt(contexts),
      similarEventIds: contexts.map((context) => context.eventId),
      confidenceDelta: confidenceAdjustment.delta,
      confidenceReason: confidenceAdjustment.reason,
    }
  } catch {
    // Memory retrieval remains non-fatal, matching the legacy worker.
    return null
  }
}

async function insertTrace(
  db: ReviewQueueDb,
  queueRow: EventLlmReviewQueueRow,
  event: EventReviewRow,
  review: AppliedLlmEventReviewDecision,
  status: ReviewTraceInsert["status"]
): Promise<void> {
  await db.insertReviewTrace({
    queueRow,
    eventId: event.id,
    review,
    modelDecision: review.modelDecision,
    inputSnapshot: traceInputSnapshot(event),
    status,
  })
}

async function handleNonReviewableEvent(
  db: ReviewQueueDb,
  dependencies: ReviewQueueWorkerDependencies,
  startedRow: EventLlmReviewQueueRow,
  event: EventReviewRow,
  reason = `Event no longer reviewable (status=${event.status}, llm_status=${event.llm_review_status}).`
): Promise<EventReviewQueueRowResult> {
  await insertTrace(
    db,
    startedRow,
    event,
    buildSkippedReview(reason, dependencies.config.promptVersion),
    "skipped"
  )
  await db.markReviewQueueRowSucceeded(startedRow.id)
  return { outcome: "skipped", appliedDecision: null, failed: false }
}

async function maybeAutoRejectSource(
  db: ReviewQueueDb,
  dependencies: ReviewQueueWorkerDependencies,
  startedRow: EventLlmReviewQueueRow,
  event: EventReviewRow
): Promise<EventReviewQueueRowResult | null> {
  if (!startedRow.source_id) return null

  try {
    // The source RPC is intentionally unreachable unless this flag is enabled.
    if (!(await isMemoryFeatureEnabled(db, "source-auto-reject"))) return null
    if (!(await db.shouldAutoRejectSource(startedRow.source_id))) return null

    const review: AppliedLlmEventReviewDecision = {
      status: LLM_EVENT_REVIEW_STATUS.SUCCEEDED,
      modelDecision: LLM_EVENT_REVIEW_DECISION.REJECT,
      appliedDecision: LLM_EVENT_REVIEW_DECISION.REJECT,
      confidence: 0.95,
      reason: "Source has consistently high rejection rate; auto-rejected without LLM review.",
      flags: ["source_auto_rejected"],
      suggestedCategory: null,
      normalizedTitle: null,
      provider: null,
      model: null,
      promptVersion: dependencies.config.promptVersion,
      rawResponse: null,
      errorCode: null,
      errorMessage: null,
      processingMs: 0,
    }
    const applied = await db.applyEventDecision({ event, queueRow: startedRow, review })
    if (!applied) {
      return handleNonReviewableEvent(
        db,
        dependencies,
        startedRow,
        event,
        "Event status changed while applying review decision."
      )
    }

    logEdgeEvent("log", "event_review_source_auto_rejected", {
      function: "process-event-review-queue",
      queue_id: startedRow.id,
      event_id: event.id,
      source_id: startedRow.source_id,
    })
    return {
      outcome: "succeeded",
      appliedDecision: LLM_EVENT_REVIEW_DECISION.REJECT,
      failed: false,
    }
  } catch {
    // Auto-reject lookup failures are non-fatal; continue to normal review.
    return null
  }
}

function logReviewSignals(
  dependencies: ReviewQueueWorkerDependencies,
  startedRow: EventLlmReviewQueueRow,
  event: EventReviewRow,
  review: AppliedLlmEventReviewDecision
): void {
  if (review.status === LLM_EVENT_REVIEW_STATUS.FAILED) {
    logEdgeEvent("warn", "event_review_provider_failed", {
      function: "process-event-review-queue",
      queue_id: startedRow.id,
      event_id: event.id,
      error_code: review.errorCode,
      error_message: review.errorMessage,
    })
    if (review.errorCode === "malformed_json" || review.errorCode === "schema_validation_error") {
      logEdgeEvent("warn", "event_review_malformed_response", {
        function: "process-event-review-queue",
        queue_id: startedRow.id,
        event_id: event.id,
        error_code: review.errorCode,
      })
    }
  }
  if (review.flags.includes("low_confidence")) {
    logEdgeEvent("warn", "event_review_low_confidence", {
      function: "process-event-review-queue",
      queue_id: startedRow.id,
      event_id: event.id,
      confidence: review.confidence,
      threshold: dependencies.config.confidenceThreshold,
    })
  }
}

async function processReviewQueueRow(
  db: ReviewQueueDb,
  dependencies: ReviewQueueWorkerDependencies,
  row: EventLlmReviewQueueRow
): Promise<EventReviewQueueRowResult> {
  const startedRow = await db.markReviewQueueRowStarted(row.id)
  let event: EventReviewRow | null = null
  logEdgeEvent("log", "event_review_started", {
    function: "process-event-review-queue",
    queue_id: startedRow.id,
    event_id: startedRow.event_id,
    attempt_count: startedRow.attempt_count,
    max_attempts: startedRow.max_attempts,
  })

  try {
    event = await db.loadReviewEvent(startedRow.event_id)
    if (!event) {
      await db.markReviewQueueRowDead(startedRow.id, "event missing before review")
      logEdgeEvent("error", "event_review_dead_lettered", {
        function: "process-event-review-queue",
        queue_id: startedRow.id,
        event_id: startedRow.event_id,
        reason: "event_missing_before_review",
      })
      return { outcome: "dead", appliedDecision: null, failed: true }
    }

    if (!isReviewable(event)) {
      return handleNonReviewableEvent(db, dependencies, startedRow, event)
    }

    const autoRejected = await maybeAutoRejectSource(db, dependencies, startedRow, event)
    if (autoRejected) return autoRejected

    const review = await (dependencies.reviewEvent ?? reviewEventWithLlm)(
      buildReviewInput(event),
      { config: dependencies.config },
      await fetchReviewMemory(db, event.id)
    )
    const applied = await db.applyEventDecision({ event, queueRow: startedRow, review })
    if (!applied) {
      return handleNonReviewableEvent(
        db,
        dependencies,
        startedRow,
        event,
        "Event status changed while applying review decision."
      )
    }

    logReviewSignals(dependencies, startedRow, event, review)
    logEdgeEvent("log", "event_review_applied", {
      function: "process-event-review-queue",
      queue_id: startedRow.id,
      event_id: event.id,
      applied_decision: review.appliedDecision,
      model_decision: review.modelDecision,
      status: review.status,
      confidence: review.confidence,
    })
    return {
      outcome: "succeeded",
      appliedDecision: review.appliedDecision,
      failed: review.status === LLM_EVENT_REVIEW_STATUS.FAILED,
    }
  } catch (error) {
    const message = errorMessage(error)
    if (event) {
      try {
        await insertTrace(
          db,
          startedRow,
          event,
          buildFailedReview(message, dependencies.config.promptVersion),
          "failed"
        )
      } catch (traceError) {
        logEdgeEvent("error", "event_review_trace_failed", {
          function: "process-event-review-queue",
          queue_id: startedRow.id,
          event_id: startedRow.event_id,
          error: errorMessage(traceError),
        })
      }
    }

    if (startedRow.attempt_count >= startedRow.max_attempts) {
      await db.markReviewQueueRowDead(startedRow.id, message.slice(0, 1000))
      logEdgeEvent("error", "event_review_dead_lettered", {
        function: "process-event-review-queue",
        queue_id: startedRow.id,
        event_id: startedRow.event_id,
        reason: message,
      })
      return { outcome: "dead", appliedDecision: null, failed: true }
    }

    const nextAttemptAt = new Date(
      (dependencies.now?.() ?? Date.now()) +
        backoffMs(startedRow.attempt_count, dependencies.config.retryBaseMs)
    ).toISOString()
    await db.scheduleReviewQueueRetry(startedRow.id, nextAttemptAt, message.slice(0, 1000))
    return { outcome: "retrying", appliedDecision: null, failed: true }
  }
}

/** One review-queue batch with the legacy 60-row default, 3-row concurrency, and 110s budget. */
export async function processReviewQueueBatch(
  db: ReviewQueueDb,
  dependencies: ReviewQueueWorkerDependencies
): Promise<ReviewQueueBatchSummary> {
  const startedAt = dependencies.now?.() ?? Date.now()
  const summary: ReviewQueueBatchSummary = {
    claimed: 0,
    reaped: 0,
    succeeded: 0,
    failed: 0,
    retrying: 0,
    dead: 0,
    approved: 0,
    rejected: 0,
    needsAdminReview: 0,
  }

  summary.reaped = await db.reapStuckReviewQueueRows()
  const claimed = await db.claimReviewQueueBatch(resolveBatchSize(dependencies.batchSize))
  summary.claimed = claimed.length
  logEdgeEvent("log", "event_review_queue_claimed", {
    function: "process-event-review-queue",
    claimed: summary.claimed,
    reaped: summary.reaped,
  })

  for (let index = 0; index < claimed.length; index += REVIEW_CONCURRENCY) {
    const elapsed = (dependencies.now?.() ?? Date.now()) - startedAt
    if (shouldStopBeforeStartingNextRow(elapsed)) {
      const unstartedIds = claimed.slice(index).map((row) => row.id)
      if (unstartedIds.length > 0) await db.releaseUnstartedReviewQueueRows(unstartedIds)
      break
    }

    const results = await Promise.all(
      claimed
        .slice(index, index + REVIEW_CONCURRENCY)
        .map((row) => processReviewQueueRow(db, dependencies, row))
    )
    for (const result of results) {
      if (result.outcome === "succeeded" || result.outcome === "skipped") {
        summary.succeeded += 1
        if (result.appliedDecision === LLM_EVENT_REVIEW_DECISION.APPROVE) summary.approved += 1
        if (result.appliedDecision === LLM_EVENT_REVIEW_DECISION.REJECT) summary.rejected += 1
        if (result.appliedDecision === LLM_EVENT_REVIEW_DECISION.NEEDS_ADMIN_REVIEW) {
          summary.needsAdminReview += 1
        }
        if (result.failed) summary.failed += 1
      } else if (result.outcome === "retrying") {
        summary.retrying += 1
        summary.failed += 1
      } else {
        summary.dead += 1
        summary.failed += 1
      }
    }
  }

  logEdgeEvent("log", "event review queue batch done", {
    function: "process-event-review-queue",
    ...summary,
  })
  return summary
}
