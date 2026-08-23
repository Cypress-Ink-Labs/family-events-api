import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import type { DbService } from "../../src/db/db.service.js"
import type {
  EventLlmReviewQueueRow,
  EventReviewRow,
  ReviewTraceInsert,
} from "../../src/pipeline/review/process-review-queue.js"
import { ReviewRepository } from "../../src/pipeline/review/review.repository.js"
import type { AppliedLlmEventReviewDecision } from "../../src/pipeline/review/event-review/index.js"

import { createIntegrationDb } from "./db.js"
import { ensureIngestionSchema, truncateIngestion } from "./ingestion-catalog.js"

// U29: real-database correctness tests for ReviewRepository, the pg
// implementation of ReviewQueueDb. Every queue row references a real event,
// and every event references a real city. Source/run FKs are seeded whenever
// those ids are present.
//
// Excluded from focused coverage: fetchEventEmbedding and findSimilarEvents.
// The disposable catalog intentionally has no pgvector/event_embeddings
// coverage. The delegated non-vector MemoryContextDb reads are already covered
// exhaustively by classification.repository.integration.test.ts.

let db: DbService
let repo: ReviewRepository

beforeAll(async () => {
  db = createIntegrationDb()
  await ensureIngestionSchema(db)
  repo = new ReviewRepository(db)
})

afterAll(async () => {
  await db.onModuleDestroy()
})

beforeEach(async () => {
  await truncateIngestion(db)
})

async function seedCity(): Promise<string> {
  const id = randomUUID()
  await db.query(
    `INSERT INTO public.cities (id, name, state, slug, timezone)
     VALUES ($1::uuid, 'Lafayette', 'LA', $2, 'America/Chicago')`,
    [id, `lafayette-${id.slice(0, 8)}`]
  )
  return id
}

async function seedSource(cityId: string): Promise<string> {
  const id = randomUUID()
  await db.query(
    `INSERT INTO public.event_sources (id, name, url, city_id)
     VALUES ($1::uuid, 'Library Calendar', $2, $3::uuid)`,
    [id, `https://example.com/${id}`, cityId]
  )
  return id
}

async function seedSourceRun(sourceId: string): Promise<string> {
  const id = randomUUID()
  await db.query(
    `INSERT INTO public.source_runs (id, source_id, status)
     VALUES ($1::uuid, $2::uuid, 'success')`,
    [id, sourceId]
  )
  return id
}

async function seedEvent(
  overrides: Partial<{
    cityId: string
    sourceId: string | null
    status: EventReviewRow["status"]
    llmReviewStatus: string
    title: string
  }> = {}
): Promise<{ eventId: string; cityId: string }> {
  const cityId = overrides.cityId ?? (await seedCity())
  const eventId = randomUUID()
  await db.query(
    `INSERT INTO public.events
       (id, city_id, source_id, title, description, start_datetime, end_datetime,
        timezone, venue_name, address, source_name, source_url, status, llm_review_status)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'Songs and stories for toddlers.',
             '2026-09-01T15:00:00Z', '2026-09-01T16:00:00Z', 'America/Chicago',
             'Main Library', '301 W Congress St', 'Library Calendar', $5,
             $6::public.event_status, $7::public.llm_event_review_status)`,
    [
      eventId,
      cityId,
      overrides.sourceId ?? null,
      overrides.title ?? "Story Time",
      `https://example.com/events/${eventId}`,
      overrides.status ?? "draft",
      overrides.llmReviewStatus ?? "pending",
    ]
  )
  return { eventId, cityId }
}

async function enqueueReview(
  overrides: Partial<{
    eventId: string
    sourceId: string | null
    sourceRunId: string | null
    status: EventLlmReviewQueueRow["status"]
    nextAttemptAt: string
    startedAt: string | null
    lastError: string | null
  }> = {}
): Promise<number> {
  const eventId = overrides.eventId ?? (await seedEvent()).eventId
  const rows = await db.query<{ id: number }>(
    `INSERT INTO public.event_llm_review_queue
       (event_id, source_id, source_run_id, trigger_type, status, next_attempt_at,
        started_at, last_error)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'import',
             $4::public.llm_event_review_queue_status, $5::timestamptz,
             $6::timestamptz, $7)
     RETURNING id::int AS id`,
    [
      eventId,
      overrides.sourceId ?? null,
      overrides.sourceRunId ?? null,
      overrides.status ?? "pending",
      overrides.nextAttemptAt ?? "2026-08-01T00:00:00Z",
      overrides.startedAt ?? null,
      overrides.lastError ?? null,
    ]
  )
  return rows[0]!.id
}

async function queueState(id: number) {
  const rows = await db.query<{
    status: EventLlmReviewQueueRow["status"]
    attempt_count: number
    started_at: string | null
    finished_at: string | null
    next_attempt_at: string
    last_error: string | null
  }>(
    `SELECT status::text, attempt_count, started_at, finished_at, next_attempt_at, last_error
     FROM public.event_llm_review_queue WHERE id = $1::bigint`,
    [id]
  )
  return rows[0]!
}

const approveReview: AppliedLlmEventReviewDecision = {
  status: "succeeded",
  modelDecision: "approve",
  appliedDecision: "approve",
  confidence: 0.94,
  reason: "Complete and family-friendly listing.",
  flags: ["family_friendly"],
  suggestedCategory: "education",
  normalizedTitle: "Toddler Story Time",
  provider: "openai",
  model: "gpt-5.4-nano",
  promptVersion: "event-review-v2",
  rawResponse: { decision: "approve", confidence: 0.94 },
  errorCode: null,
  errorMessage: null,
  processingMs: 321,
}

async function activateReview(eventId?: string): Promise<{
  queueId: number
  row: EventLlmReviewQueueRow
}> {
  const queueId = await enqueueReview({ eventId })
  await repo.claimReviewQueueBatch(1)
  return { queueId, row: await repo.markReviewQueueRowStarted(queueId) }
}

describe("ReviewQueueDb queue operations", () => {
  it("claims due rows in RPC order and exposes the typed queue shape", async () => {
    const later = await enqueueReview({ nextAttemptAt: "2026-08-02T00:00:00Z" })
    const first = await enqueueReview({ nextAttemptAt: "2026-08-01T00:00:00Z" })

    const rows = await repo.claimReviewQueueBatch(1)

    expect(rows).toEqual([
      expect.objectContaining({
        id: first,
        status: "processing",
        trigger_type: "import",
        attempt_count: 0,
        max_attempts: 3,
      }),
    ])
    expect(rows[0]!.event_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(rows[0]!.next_attempt_at).toBe("2026-08-01T00:00:00.000Z")
    expect((await queueState(later)).status).toBe("pending")
  })

  it("marks a claimed row started through the public RPC", async () => {
    const queueId = await enqueueReview()
    const [claimed] = await repo.claimReviewQueueBatch(1)

    const started = await repo.markReviewQueueRowStarted(queueId)

    expect(claimed!.id).toBe(queueId)
    expect(started.id).toBe(queueId)
    expect(started.status).toBe("processing")
    expect(started.attempt_count).toBe(1)
    expect((await queueState(queueId)).started_at).not.toBeNull()
  })

  it("releases only unstarted claimed rows", async () => {
    const unstartedId = await enqueueReview()
    const startedId = await enqueueReview()
    await repo.claimReviewQueueBatch(2)
    await repo.markReviewQueueRowStarted(startedId)

    await repo.releaseUnstartedReviewQueueRows([unstartedId, startedId])

    expect((await queueState(unstartedId)).status).toBe("pending")
    expect((await queueState(startedId)).status).toBe("processing")
  })

  it("reaps stuck processing rows through the public RPC", async () => {
    const queueId = await enqueueReview({
      status: "processing",
      startedAt: "2026-08-01T00:00:00Z",
    })

    expect(await repo.reapStuckReviewQueueRows()).toBe(1)
    expect(await queueState(queueId)).toMatchObject({
      status: "retrying",
      started_at: null,
      last_error: "reaped after stuck in processing",
    })
  })

  it("writes succeeded, dead, and retry queue outcomes", async () => {
    const succeeded = await activateReview()
    await repo.markReviewQueueRowSucceeded(succeeded.queueId)
    expect(await queueState(succeeded.queueId)).toMatchObject({
      status: "succeeded",
      last_error: null,
    })
    expect((await queueState(succeeded.queueId)).finished_at).not.toBeNull()

    const dead = await activateReview()
    await repo.markReviewQueueRowDead(dead.queueId, "permanent failure")
    expect(await queueState(dead.queueId)).toMatchObject({
      status: "dead",
      last_error: "permanent failure",
    })
    expect((await queueState(dead.queueId)).finished_at).not.toBeNull()

    const retry = await activateReview()
    await repo.scheduleReviewQueueRetry(retry.queueId, "2026-09-02T03:04:05Z", "temporary failure")
    expect(await queueState(retry.queueId)).toMatchObject({
      status: "retrying",
      started_at: null,
      last_error: "temporary failure",
    })
    expect((await queueState(retry.queueId)).next_attempt_at).toContain("2026-09-02 03:04:05")
  })
})

describe("ReviewQueueDb event and trace reads/writes", () => {
  it("loads the exact review input columns and returns null for a missing event", async () => {
    const { eventId } = await seedEvent()

    expect(await repo.loadReviewEvent(eventId)).toEqual({
      id: eventId,
      status: "draft",
      title: "Story Time",
      description: "Songs and stories for toddlers.",
      start_datetime: "2026-09-01T15:00:00.000Z",
      end_datetime: "2026-09-01T16:00:00.000Z",
      timezone: "America/Chicago",
      venue_name: "Main Library",
      address: "301 W Congress St",
      source_name: "Library Calendar",
      source_url: `https://example.com/events/${eventId}`,
      llm_review_status: "pending",
      llm_review_decision: null,
    })
    expect(await repo.loadReviewEvent(randomUUID())).toBeNull()
  })

  it("writes skipped/pre-apply failure traces without completing the queue row", async () => {
    const { eventId, cityId } = await seedEvent()
    const sourceId = await seedSource(cityId)
    const sourceRunId = await seedSourceRun(sourceId)
    const queueId = await enqueueReview({ eventId, sourceId, sourceRunId })
    const [queueRow] = await repo.claimReviewQueueBatch(1)
    const skipped = {
      ...approveReview,
      status: "failed" as const,
      appliedDecision: "needs_admin_review" as const,
    }
    const params: ReviewTraceInsert = {
      queueRow: queueRow!,
      eventId,
      review: skipped,
      modelDecision: skipped.modelDecision,
      inputSnapshot: { title: "Story Time", source_name: "Library Calendar" },
      status: "skipped",
    }

    await repo.insertReviewTrace(params)

    const [trace] = await db.query<Record<string, unknown>>(
      "SELECT * FROM public.event_llm_review_traces WHERE queue_id = $1::bigint",
      [queueId]
    )
    expect(trace).toMatchObject({
      event_id: eventId,
      queue_id: String(queueId),
      source_id: sourceId,
      source_run_id: sourceRunId,
      provider: "openai",
      model: "gpt-5.4-nano",
      prompt_version: "event-review-v2",
      status: "skipped",
      model_decision: "approve",
      applied_decision: "needs_admin_review",
      reason: approveReview.reason,
      flags: ["family_friendly"],
      suggested_category: "education",
      normalized_title: "Toddler Story Time",
      raw_response: approveReview.rawResponse,
      processing_ms: 321,
      input_snapshot: { title: "Story Time", source_name: "Library Calendar" },
    })
    expect((await queueState(queueId)).status).toBe("processing")
  })

  it("reads event city scope and delegates non-vector memory reads", async () => {
    const { eventId, cityId } = await seedEvent()
    await db.query(
      `INSERT INTO public.approved_ai_models (id, provider, display_name)
       VALUES ('review-model', 'openai', 'Review Model')`
    )
    await db.query(
      `INSERT INTO public.ai_feature_config (feature, model_id, enabled)
       VALUES ('review-memory', 'review-model', true)`
    )

    expect(await repo.fetchEventCityId(eventId)).toBe(cityId)
    expect(await repo.fetchEventCityId(randomUUID())).toBeNull()
    expect(await repo.getMemoryFeatureFlag("review-memory")).toEqual({ enabled: true })
  })
})

describe("ReviewQueueDb decisions", () => {
  it("claim → start → approve publishes once, traces once, enqueues tags, and succeeds", async () => {
    const cityId = await seedCity()
    const sourceId = await seedSource(cityId)
    const sourceRunId = await seedSourceRun(sourceId)
    const { eventId } = await seedEvent({ cityId, sourceId })
    const queueId = await enqueueReview({ eventId, sourceId, sourceRunId })
    const [claimed] = await repo.claimReviewQueueBatch(1)
    const started = await repo.markReviewQueueRowStarted(queueId)
    const event = await repo.loadReviewEvent(eventId)

    expect(claimed!.id).toBe(queueId)
    expect(started.attempt_count).toBe(1)
    expect(event).not.toBeNull()
    expect(
      await repo.applyEventDecision({ event: event!, queueRow: started, review: approveReview })
    ).toBe(true)

    const [storedEvent] = await db.query<Record<string, unknown>>(
      `SELECT status::text, llm_review_status::text, llm_review_decision::text,
              llm_review_confidence, llm_review_provider, llm_review_model,
              llm_review_prompt_version, llm_review_reason, llm_review_flags
       FROM public.events WHERE id = $1::uuid`,
      [eventId]
    )
    expect(storedEvent).toMatchObject({
      status: "published",
      llm_review_status: "succeeded",
      llm_review_decision: "approve",
      llm_review_confidence: "0.940",
      llm_review_provider: "openai",
      llm_review_model: "gpt-5.4-nano",
      llm_review_prompt_version: "event-review-v2",
      llm_review_reason: approveReview.reason,
      llm_review_flags: ["family_friendly"],
    })
    const traces = await db.query<Record<string, unknown>>(
      "SELECT * FROM public.event_llm_review_traces WHERE event_id = $1::uuid",
      [eventId]
    )
    const tagRows = await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM public.event_tag_queue WHERE event_id = $1::uuid",
      [eventId]
    )
    expect(traces).toHaveLength(1)
    expect(traces[0]).toMatchObject({
      queue_id: String(queueId),
      source_id: sourceId,
      source_run_id: sourceRunId,
      provider: "openai",
      model: "gpt-5.4-nano",
      prompt_version: "event-review-v2",
      status: "succeeded",
      model_decision: "approve",
      applied_decision: "approve",
      confidence: "0.940",
      reason: approveReview.reason,
      flags: ["family_friendly"],
      suggested_category: "education",
      normalized_title: "Toddler Story Time",
      raw_response: approveReview.rawResponse,
      error_code: null,
      error_message: null,
      input_snapshot: {
        title: "Story Time",
        start_datetime: "2026-09-01T15:00:00.000Z",
        source_name: "Library Calendar",
        source_url: `https://example.com/events/${eventId}`,
      },
      processing_ms: 321,
    })
    expect(tagRows[0]!.count).toBe(1)
    expect(await queueState(queueId)).toMatchObject({ status: "succeeded", last_error: null })
  })

  it("rejects the event with one reject trace and suppresses tag enqueue", async () => {
    const cityId = await seedCity()
    const sourceId = await seedSource(cityId)
    const sourceRunId = await seedSourceRun(sourceId)
    const { eventId } = await seedEvent({ cityId, sourceId })
    const queueId = await enqueueReview({ eventId, sourceId, sourceRunId })
    await repo.claimReviewQueueBatch(1)
    const started = await repo.markReviewQueueRowStarted(queueId)
    const event = await repo.loadReviewEvent(eventId)
    const rejectReview: AppliedLlmEventReviewDecision = {
      ...approveReview,
      modelDecision: "reject",
      appliedDecision: "reject",
      confidence: 0.97,
      reason: "Listing is not a family event.",
      flags: ["not_family_event"],
      suggestedCategory: null,
      normalizedTitle: null,
      rawResponse: { decision: "reject", confidence: 0.97 },
    }

    expect(
      await repo.applyEventDecision({ event: event!, queueRow: started, review: rejectReview })
    ).toBe(true)

    const storedEvents = await db.query<{ status: string; llm_review_decision: string | null }>(
      `SELECT status::text, llm_review_decision::text
       FROM public.events WHERE id = $1::uuid`,
      [eventId]
    )
    const traces = await db.query<{
      model_decision: string | null
      applied_decision: string | null
    }>(
      `SELECT model_decision::text, applied_decision::text
       FROM public.event_llm_review_traces WHERE event_id = $1::uuid`,
      [eventId]
    )
    const tagRows = await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM public.event_tag_queue WHERE event_id = $1::uuid",
      [eventId]
    )

    expect(storedEvents[0]).toEqual({ status: "rejected", llm_review_decision: "reject" })
    expect(traces).toEqual([{ model_decision: "reject", applied_decision: "reject" }])
    expect(tagRows[0]!.count).toBe(0)
    expect(await queueState(queueId)).toMatchObject({ status: "succeeded", last_error: null })
  })

  it("returns false without a trace or queue completion for a non-draft event", async () => {
    const { eventId } = await seedEvent({ status: "published", llmReviewStatus: "pending" })
    const { queueId, row } = await activateReview(eventId)
    const event = await repo.loadReviewEvent(eventId)

    expect(
      await repo.applyEventDecision({ event: event!, queueRow: row, review: approveReview })
    ).toBe(false)

    const traces = await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM public.event_llm_review_traces WHERE event_id = $1::uuid",
      [eventId]
    )
    expect(traces[0]!.count).toBe(0)
    expect((await queueState(queueId)).status).toBe("processing")
  })

  it("auto-rejects only sources above the production rejection threshold", async () => {
    const cityId = await seedCity()
    const sourceId = await seedSource(cityId)
    for (let i = 0; i < 5; i += 1) {
      await seedEvent({ cityId, sourceId, status: "rejected" })
    }

    expect(await repo.shouldAutoRejectSource(sourceId)).toBe(true)
    expect(await repo.shouldAutoRejectSource(randomUUID())).toBe(false)
  })
})
