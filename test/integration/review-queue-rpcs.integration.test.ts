import { randomUUID } from "node:crypto"

import type { PoolClient } from "pg"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import type { DbService } from "../../src/db/db.service.js"

import { createIntegrationDb } from "./db.js"
import { ensureIngestionSchema, truncateIngestion } from "./ingestion-catalog.js"

// U29: the event_llm_review_queue RPCs (claim SKIP LOCKED, mark-started,
// release unstarted, reap stuck, apply decision, should_auto_reject_source) —
// REAL SQL extracted verbatim from the backend migrations
// (test/integration/sql/event_llm_review_queue_rpcs.sql). Deeper worker-level
// behavior arrives with the review queue repository in a later task; this file
// is a correctness smoke test of the SQL itself.

let db: DbService

beforeAll(async () => {
  db = createIntegrationDb()
  await ensureIngestionSchema(db)
})

afterAll(async () => {
  await db.onModuleDestroy()
})

beforeEach(async () => {
  await truncateIngestion(db)
})

async function seedCity(id: string = randomUUID()): Promise<string> {
  const slug = `test-city-${id.slice(0, 8)}`
  await db.query(
    `INSERT INTO public.cities (id, name, state, slug, timezone)
     VALUES ($1, 'Test City', 'TX', $2, 'America/Chicago')`,
    [id, slug]
  )
  return id
}

async function seedSource(cityId?: string): Promise<{ cityId: string; sourceId: string }> {
  const sourceCityId = cityId ?? (await seedCity())
  const sourceId = randomUUID()
  await db.query(
    `INSERT INTO public.event_sources (id, name, url, city_id)
     VALUES ($1::uuid, 'Test Source', $2, $3::uuid)`,
    [sourceId, `https://example.com/sources/${sourceId}`, sourceCityId]
  )
  return { cityId: sourceCityId, sourceId }
}

async function seedEvent(
  overrides: Partial<{
    id: string
    city_id: string
    status: string
    source_id: string
    llm_review_status: string
  }> = {}
): Promise<string> {
  const cityId = overrides.city_id ?? (await seedCity())
  const eventId = overrides.id ?? randomUUID()
  await db.query(
    `INSERT INTO public.events
       (id, city_id, title, start_datetime, status, llm_review_status, source_id)
     VALUES ($1::uuid, $2::uuid, 'Test Event', now(), $3::public.event_status,
             COALESCE($4::public.llm_event_review_status, 'not_required'::public.llm_event_review_status),
             $5::uuid)`,
    [
      eventId,
      cityId,
      overrides.status ?? "draft",
      overrides.llm_review_status ?? null,
      overrides.source_id ?? null,
    ]
  )
  return eventId
}

async function enqueueReview(
  overrides: Partial<{
    event_id: string
    source_id: string
    source_run_id: string
    status: string
    next_attempt_at: string
    started_at: string | null
    last_error: string | null
  }> = {}
): Promise<number> {
  const eventId = overrides.event_id ?? (await seedEvent())
  const rows = await db.query<{ id: number }>(
    `INSERT INTO public.event_llm_review_queue
       (event_id, source_id, source_run_id, trigger_type, status, next_attempt_at, started_at, last_error)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'import', $4::public.llm_event_review_queue_status,
             COALESCE($5::timestamptz, now()), $6::timestamptz, $7)
     RETURNING id::int AS id`,
    [
      eventId,
      overrides.source_id ?? null,
      overrides.source_run_id ?? null,
      overrides.status ?? "pending",
      overrides.next_attempt_at ?? null,
      overrides.started_at ?? null,
      overrides.last_error ?? null,
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
  }>(
    `SELECT status::text, attempt_count, started_at, next_attempt_at, last_error
     FROM public.event_llm_review_queue WHERE id = $1::bigint`,
    [id]
  )
  return rows[0]!
}

async function eventById(id: string) {
  const rows = await db.query<{
    status: string
    llm_review_status: string | null
    llm_review_decision: string | null
    llm_reviewed_at: string | null
  }>(
    `SELECT status::text, llm_review_status::text, llm_review_decision::text, llm_reviewed_at
     FROM public.events WHERE id = $1::uuid`,
    [id]
  )
  return rows[0]!
}

// ── RPC call helpers (one place per RPC keeps the SQL strings single-sourced) ─

async function claimBatch(limit: number): Promise<number[]> {
  const rows = await db.query<{ id: number }>(
    "SELECT id::int AS id FROM public.claim_event_llm_review_queue_batch($1::int)",
    [limit]
  )
  return rows.map((row) => row.id)
}

async function markStarted(
  id: number
): Promise<{ attempt_count: number; started_at: string | null }> {
  const rows = await db.query<{ attempt_count: number; started_at: string | null }>(
    "SELECT attempt_count, started_at FROM public.mark_event_llm_review_queue_row_started($1::bigint)",
    [id]
  )
  return rows[0]!
}

async function releaseUnstarted(ids: number[]): Promise<number> {
  const rows = await db.query<{ released: number }>(
    "SELECT public.release_unstarted_event_llm_review_rows($1::bigint[]) AS released",
    [ids]
  )
  return Number(rows[0]?.released)
}

async function reapStuck(): Promise<number> {
  const rows = await db.query<{ reaped: number }>(
    "SELECT public.reap_stuck_event_llm_review_rows() AS reaped"
  )
  return Number(rows[0]?.reaped)
}

async function applyDecision(params: {
  queue_id: number
  event_id: string
  source_id?: string | null
  source_run_id?: string | null
  provider?: string | null
  model?: string | null
  prompt_version: string
  review_status: string
  model_decision: string | null
  applied_decision: string
  confidence?: number | null
  reason: string
  flags?: string[] | null
  suggested_category?: string | null
  normalized_title?: string | null
  raw_response?: object | null
  error_code?: string | null
  error_message?: string | null
  input_snapshot?: object | null
  processing_ms?: number | null
}): Promise<boolean> {
  const rows = await db.query<{ applied: boolean }>(
    `SELECT public.apply_event_llm_review_decision(
      $1::bigint, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7,
      $8::public.llm_event_review_status,
      $9::public.llm_event_review_decision,
      $10::public.llm_event_review_decision,
      $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
    ) AS applied`,
    [
      params.queue_id,
      params.event_id,
      params.source_id ?? null,
      params.source_run_id ?? null,
      params.provider ?? null,
      params.model ?? null,
      params.prompt_version,
      params.review_status,
      params.model_decision ?? null,
      params.applied_decision,
      params.confidence ?? null,
      params.reason,
      params.flags ?? null,
      params.suggested_category ?? null,
      params.normalized_title ?? null,
      params.raw_response ?? null,
      params.error_code ?? null,
      params.error_message ?? null,
      params.input_snapshot ?? null,
      params.processing_ms ?? null,
    ]
  )
  return rows[0]!.applied
}

async function shouldAutoRejectSource(
  sourceId: string,
  threshold = 0.8,
  minEvents = 5,
  windowDays = 30
): Promise<boolean> {
  const rows = await db.query<{ should_reject: boolean }>(
    "SELECT public.should_auto_reject_source($1::uuid, $2::float, $3::int, $4::int) AS should_reject",
    [sourceId, threshold, minEvents, windowDays]
  )
  return rows[0]!.should_reject
}

describe("review ingestion catalog", () => {
  it("preserves the production llm_review_status enum, nullability, and default", async () => {
    const [column] = await db.query<{
      udt_schema: string
      udt_name: string
      is_nullable: string
      column_default: string | null
    }>(
      `SELECT udt_schema, udt_name, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'events'
         AND column_name = 'llm_review_status'`
    )

    expect(column).toMatchObject({
      udt_schema: "public",
      udt_name: "llm_event_review_status",
      is_nullable: "NO",
    })
    expect(column?.column_default).toContain("'not_required'::")
  })

  it("enforces the production events source FK with ON DELETE SET NULL", async () => {
    const [constraint] = await db.query<{ constraint_name: string; delete_rule: string }>(
      `SELECT constraint_name, delete_rule
       FROM information_schema.referential_constraints
       WHERE constraint_schema = 'public'
         AND constraint_name = 'events_source_id_fkey'`
    )

    expect(constraint).toEqual({
      constraint_name: "events_source_id_fkey",
      delete_rule: "SET NULL",
    })
  })
})

describe("claim_event_llm_review_queue_batch (real SQL)", () => {
  it("claims oldest-first by next_attempt_at then enqueued_at, marks processing with started_at cleared", async () => {
    const second = await enqueueReview({ next_attempt_at: "2026-06-02T00:00:00Z" })
    const first = await enqueueReview({ next_attempt_at: "2026-06-01T00:00:00Z" })

    expect(await claimBatch(1)).toEqual([first])
    const firstRow = await queueRowById(first)
    expect(firstRow.status).toBe("processing")
    expect(firstRow.started_at).toBeNull()

    expect(await claimBatch(1)).toEqual([second])

    expect(await claimBatch(1)).toEqual([])
  })

  it("respects p_limit", async () => {
    await enqueueReview({ next_attempt_at: "2026-06-01T00:00:00Z" })
    await enqueueReview({ next_attempt_at: "2026-06-02T00:00:00Z" })
    await enqueueReview({ next_attempt_at: "2026-06-03T00:00:00Z" })

    const claimed = await claimBatch(2)
    expect(claimed).toHaveLength(2)
  })

  it("does not claim rows parked in the future", async () => {
    await enqueueReview({ next_attempt_at: "2199-01-01T00:00:00Z" })
    expect(await claimBatch(5)).toEqual([])
  })

  it("claims both pending and retrying rows", async () => {
    const pending = await enqueueReview({ status: "pending" })
    const retrying = await enqueueReview({ status: "retrying" })
    const claimed = await claimBatch(5)
    expect(claimed).toEqual(expect.arrayContaining([pending, retrying]))
  })

  it("does not claim rows that are processing, succeeded, or dead", async () => {
    await enqueueReview({ status: "processing" })
    await enqueueReview({ status: "succeeded" })
    await enqueueReview({ status: "dead" })
    expect(await claimBatch(5)).toEqual([])
  })

  it("skips a row locked by another claimant and returns a disjoint row without blocking", async () => {
    const first = await enqueueReview({ next_attempt_at: "2026-06-01T00:00:00Z" })
    const second = await enqueueReview({ next_attempt_at: "2026-06-02T00:00:00Z" })
    let lockingClient: PoolClient | undefined
    let concurrentClient: PoolClient | undefined

    try {
      lockingClient = await db.pool.connect()
      concurrentClient = await db.pool.connect()
      await lockingClient.query("BEGIN")
      await concurrentClient.query("BEGIN")
      await lockingClient.query("SET LOCAL statement_timeout = '1000ms'")
      await concurrentClient.query("SET LOCAL statement_timeout = '1000ms'")

      const lockedClaim = await lockingClient.query<{ id: number }>(
        "SELECT id::int AS id FROM public.claim_event_llm_review_queue_batch(1)"
      )
      expect(lockedClaim.rows.map((row) => row.id)).toEqual([first])

      const concurrentClaim = await concurrentClient.query<{ id: number }>(
        "SELECT id::int AS id FROM public.claim_event_llm_review_queue_batch(1)"
      )
      expect(concurrentClaim.rows.map((row) => row.id)).toEqual([second])
    } finally {
      if (concurrentClient) {
        await concurrentClient.query("ROLLBACK").catch(() => undefined)
        concurrentClient.release()
      }
      if (lockingClient) {
        await lockingClient.query("ROLLBACK").catch(() => undefined)
        lockingClient.release()
      }
    }
  })
})

describe("mark_event_llm_review_queue_row_started (real SQL)", () => {
  it("stamps started_at and increments attempt_count for a claimed row", async () => {
    const id = await enqueueReview()
    await claimBatch(1)

    const started = await markStarted(id)
    expect(started.attempt_count).toBe(1)
    expect(started.started_at).not.toBeNull()

    const row = await queueRowById(id)
    expect(row.attempt_count).toBe(1)
    expect(row.started_at).not.toBeNull()
  })

  it("returns an all-null row (no match) when called on a row that is not processing/unstarted", async () => {
    const id = await enqueueReview() // still pending — never claimed
    const [row] = await db.query<{ id: number | null; attempt_count: number | null }>(
      "SELECT id::int AS id, attempt_count FROM public.mark_event_llm_review_queue_row_started($1::bigint)",
      [id]
    )
    expect(row?.id).toBeNull()
    expect((await queueRowById(id)).attempt_count).toBe(0)
  })

  it("does not double-stamp a row that was already marked started", async () => {
    const id = await enqueueReview()
    await claimBatch(1)
    await markStarted(id)

    const [again] = await db.query<{ id: number | null }>(
      "SELECT id::int AS id FROM public.mark_event_llm_review_queue_row_started($1::bigint)",
      [id]
    )
    expect(again?.id).toBeNull()
    expect((await queueRowById(id)).attempt_count).toBe(1)
  })
})

describe("release_unstarted_event_llm_review_rows (real SQL)", () => {
  it("returns unstarted claims to pending", async () => {
    const id = await enqueueReview()
    await claimBatch(1)

    expect(await releaseUnstarted([id])).toBe(1)
    const queueRow = await queueRowById(id)
    expect(queueRow.status).toBe("pending")
    expect(queueRow.started_at).toBeNull()
  })

  it("does not release a row that was already marked started", async () => {
    const id = await enqueueReview()
    await claimBatch(1)
    await markStarted(id)

    expect(await releaseUnstarted([id])).toBe(0)
    expect((await queueRowById(id)).status).toBe("processing")
  })
})

describe("reap_stuck_event_llm_review_rows (real SQL)", () => {
  it("reaps rows stuck in processing with started_at over 15 minutes old", async () => {
    const id = await enqueueReview({ status: "processing", started_at: "2026-06-01T00:00:00Z" })

    expect(await reapStuck()).toBe(1)
    const queueRow = await queueRowById(id)
    expect(queueRow.status).toBe("retrying")
    expect(queueRow.started_at).toBeNull()
    expect(queueRow.last_error).toBe("reaped after stuck in processing")
  })

  it("does NOT reap rows claimed recently even if next_attempt_at is stale (fixes race)", async () => {
    // Claim stamps updated_at = now(). A row whose next_attempt_at is overdue but whose
    // updated_at is fresh should NOT be reaped (fixes the race where freshly claimed
    // overdue rows were instantly reap-eligible).
    const id = await enqueueReview({
      status: "processing",
      started_at: null,
      next_attempt_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    })
    // Manually update updated_at to fresh timestamp (simulating recent claim)
    await db.query(
      "UPDATE public.event_llm_review_queue SET updated_at = now() WHERE id = $1::bigint",
      [id]
    )

    expect(await reapStuck()).toBe(0)
    expect((await queueRowById(id)).status).toBe("processing")
  })

  it("reaps rows stuck unstarted with a stale updated_at over 5 minutes old", async () => {
    // Now the reaper checks updated_at (set by claim) not next_attempt_at (the DUE time).
    const id = await enqueueReview({
      status: "processing",
      started_at: null,
    })
    // Manually backdate updated_at to >5 minutes ago
    await db.query(
      "UPDATE public.event_llm_review_queue SET updated_at = $1::timestamptz WHERE id = $2::bigint",
      [new Date(Date.now() - 10 * 60_000).toISOString(), id]
    )

    expect(await reapStuck()).toBe(1)
    expect((await queueRowById(id)).status).toBe("retrying")
  })

  it("does not touch rows recently claimed and not yet stuck", async () => {
    const id = await enqueueReview({ status: "processing", started_at: null })

    expect(await reapStuck()).toBe(0)
    expect((await queueRowById(id)).status).toBe("processing")
  })

  it("preserves an existing last_error instead of overwriting it", async () => {
    const id = await enqueueReview({
      status: "processing",
      started_at: "2026-06-01T00:00:00Z",
      last_error: "previous failure",
    })

    await reapStuck()
    expect((await queueRowById(id)).last_error).toBe("previous failure")
  })
})

describe("apply_event_llm_review_decision (real SQL)", () => {
  it("approve → event published + trace row + event_tag_queue enqueue", async () => {
    const eventId = await seedEvent({ status: "draft" })
    const queueId = await enqueueReview({ event_id: eventId })

    const applied = await applyDecision({
      queue_id: queueId,
      event_id: eventId,
      prompt_version: "v1",
      review_status: "succeeded",
      model_decision: "approve",
      applied_decision: "approve",
      reason: "Looks good",
    })

    expect(applied).toBe(true)

    const event = await eventById(eventId)
    expect(event.status).toBe("published")
    expect(event.llm_review_decision).toBe("approve")
    expect(event.llm_reviewed_at).not.toBeNull()

    const [trace] = await db.query<{ event_id: string; applied_decision: string }>(
      "SELECT event_id::text, applied_decision::text FROM public.event_llm_review_traces WHERE event_id = $1::uuid",
      [eventId]
    )
    expect(trace?.event_id).toBe(eventId)
    expect(trace?.applied_decision).toBe("approve")

    const [tagQueue] = await db.query<{ event_id: string }>(
      "SELECT event_id::text FROM public.event_tag_queue WHERE event_id = $1::uuid",
      [eventId]
    )
    expect(tagQueue?.event_id).toBe(eventId)

    const queueRow = await queueRowById(queueId)
    expect(queueRow.status).toBe("succeeded")
  })

  it("reject → event rejected + trace + NO tag enqueue", async () => {
    const eventId = await seedEvent({ status: "draft" })
    const queueId = await enqueueReview({ event_id: eventId })

    const applied = await applyDecision({
      queue_id: queueId,
      event_id: eventId,
      prompt_version: "v1",
      review_status: "succeeded",
      model_decision: "reject",
      applied_decision: "reject",
      reason: "Low quality",
    })

    expect(applied).toBe(true)

    const event = await eventById(eventId)
    expect(event.status).toBe("rejected")
    expect(event.llm_review_decision).toBe("reject")

    const [trace] = await db.query<{ applied_decision: string }>(
      "SELECT applied_decision::text FROM public.event_llm_review_traces WHERE event_id = $1::uuid",
      [eventId]
    )
    expect(trace?.applied_decision).toBe("reject")

    const [tagQueue] = await db.query<{ event_id: string | null }>(
      "SELECT event_id::text FROM public.event_tag_queue WHERE event_id = $1::uuid",
      [eventId]
    )
    expect(tagQueue).toBeUndefined()
  })

  it("needs_admin_review → event stays draft", async () => {
    const eventId = await seedEvent({ status: "draft" })
    const queueId = await enqueueReview({ event_id: eventId })

    const applied = await applyDecision({
      queue_id: queueId,
      event_id: eventId,
      prompt_version: "v1",
      review_status: "succeeded",
      model_decision: "needs_admin_review",
      applied_decision: "needs_admin_review",
      reason: "Uncertain",
    })

    expect(applied).toBe(true)

    const event = await eventById(eventId)
    expect(event.status).toBe("draft")
    expect(event.llm_review_decision).toBe("needs_admin_review")

    const [tagQueue] = await db.query<{ event_id: string }>(
      "SELECT event_id::text FROM public.event_tag_queue WHERE event_id = $1::uuid",
      [eventId]
    )
    expect(tagQueue?.event_id).toBe(eventId)
  })

  it("returns false and leaves event alone when event is no longer draft", async () => {
    const eventId = await seedEvent({ status: "published" })
    const queueId = await enqueueReview({ event_id: eventId })

    const applied = await applyDecision({
      queue_id: queueId,
      event_id: eventId,
      prompt_version: "v1",
      review_status: "succeeded",
      model_decision: "approve",
      applied_decision: "approve",
      reason: "Looks good",
    })

    expect(applied).toBe(false)

    const event = await eventById(eventId)
    expect(event.status).toBe("published")
    expect(event.llm_review_decision).toBeNull()

    const [trace] = await db.query<{ event_id: string | null }>(
      "SELECT event_id::text FROM public.event_llm_review_traces WHERE event_id = $1::uuid",
      [eventId]
    )
    expect(trace).toBeUndefined()
  })
})

describe("should_auto_reject_source (real SQL)", () => {
  it("returns false when below min events threshold", async () => {
    const { cityId, sourceId } = await seedSource()
    await seedEvent({ city_id: cityId, source_id: sourceId, status: "rejected" })
    await seedEvent({ city_id: cityId, source_id: sourceId, status: "rejected" })

    const shouldReject = await shouldAutoRejectSource(sourceId, 0.8, 5, 30)
    expect(shouldReject).toBe(false)
  })

  it("returns true when rejection rate > threshold and has min events", async () => {
    const { cityId, sourceId } = await seedSource()
    // 9 rejected / 10 total = 0.9 > 0.8 threshold
    for (let i = 0; i < 9; i++) {
      await seedEvent({ city_id: cityId, source_id: sourceId, status: "rejected" })
    }
    for (let i = 0; i < 1; i++) {
      await seedEvent({ city_id: cityId, source_id: sourceId, status: "published" })
    }

    const shouldReject = await shouldAutoRejectSource(sourceId, 0.8, 5, 30)
    expect(shouldReject).toBe(true)
  })

  it("returns false when rejection rate below threshold", async () => {
    const { cityId, sourceId } = await seedSource()
    for (let i = 0; i < 3; i++) {
      await seedEvent({ city_id: cityId, source_id: sourceId, status: "rejected" })
    }
    for (let i = 0; i < 7; i++) {
      await seedEvent({ city_id: cityId, source_id: sourceId, status: "published" })
    }

    const shouldReject = await shouldAutoRejectSource(sourceId, 0.8, 5, 30)
    expect(shouldReject).toBe(false)
  })

  it("only considers published and rejected events within window", async () => {
    const { cityId, sourceId } = await seedSource()
    // Old events outside window
    await db.query(
      `INSERT INTO public.events (id, city_id, title, start_datetime, status, source_id, updated_at)
       VALUES ($1::uuid, $2::uuid, 'Old Event', now(), 'rejected', $3::uuid,
               now() - interval '31 days')`,
      [randomUUID(), cityId, sourceId]
    )
    // Recent events within window
    for (let i = 0; i < 5; i++) {
      await seedEvent({ city_id: cityId, source_id: sourceId, status: "rejected" })
    }

    const shouldReject = await shouldAutoRejectSource(sourceId, 0.8, 5, 30)
    expect(shouldReject).toBe(true)
  })
})
