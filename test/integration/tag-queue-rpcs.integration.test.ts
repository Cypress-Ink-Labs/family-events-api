import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import type { DbService } from "../../src/db/db.service.js"

import { createIntegrationDb } from "./db.js"
import { ensureIngestionSchema, truncateIngestion } from "./ingestion-catalog.js"

// U29: the event_tag_queue RPCs (claim SKIP LOCKED, mark-started, release
// unstarted, reap stuck) — REAL SQL extracted verbatim from the backend
// baseline (test/integration/sql/event_tag_queue_rpcs.sql). Deeper
// worker-level behavior arrives with the tag queue repository in a later
// task; this file is a correctness smoke test of the SQL itself.

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

async function enqueue(
  overrides: Partial<{
    event_id: string
    status: string
    next_attempt_at: string
    started_at: string | null
    last_error: string | null
  }> = {}
): Promise<number> {
  const rows = await db.query<{ id: number }>(
    `INSERT INTO public.event_tag_queue
       (event_id, trigger_type, status, next_attempt_at, started_at, last_error)
     VALUES ($1::uuid, 'import', $2::public.event_tag_queue_status,
             COALESCE($3::timestamptz, now()), $4::timestamptz, $5)
     RETURNING id::int AS id`,
    [
      overrides.event_id ?? randomUUID(),
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
     FROM public.event_tag_queue WHERE id = $1::bigint`,
    [id]
  )
  return rows[0]!
}

// ── RPC call helpers (one place per RPC keeps the SQL strings single-sourced) ─

async function claimBatch(limit: number): Promise<number[]> {
  const rows = await db.query<{ id: number }>(
    "SELECT id::int AS id FROM public.claim_tag_queue_batch($1::int)",
    [limit]
  )
  return rows.map((row) => row.id)
}

async function markStarted(
  id: number
): Promise<{ attempt_count: number; started_at: string | null }> {
  const rows = await db.query<{ attempt_count: number; started_at: string | null }>(
    "SELECT attempt_count, started_at FROM public.mark_tag_queue_row_started($1::bigint)",
    [id]
  )
  return rows[0]!
}

async function releaseUnstarted(ids: number[]): Promise<number> {
  const rows = await db.query<{ released: number }>(
    "SELECT public.release_unstarted_tag_queue_rows($1::bigint[]) AS released",
    [ids]
  )
  return Number(rows[0]?.released)
}

async function reapStuck(): Promise<number> {
  const rows = await db.query<{ reaped: number }>(
    "SELECT public.reap_stuck_tag_queue_rows() AS reaped"
  )
  return Number(rows[0]?.reaped)
}

describe("claim_tag_queue_batch (real SQL)", () => {
  it("claims oldest-first, marks processing with started_at cleared, and a further claim finds nothing", async () => {
    const second = await enqueue({ next_attempt_at: "2026-06-02T00:00:00Z" })
    const first = await enqueue({ next_attempt_at: "2026-06-01T00:00:00Z" })

    expect(await claimBatch(1)).toEqual([first])
    const firstRow = await queueRowById(first)
    expect(firstRow.status).toBe("processing")
    expect(firstRow.started_at).toBeNull()

    expect(await claimBatch(1)).toEqual([second])

    expect(await claimBatch(1)).toEqual([])
  })

  it("does not claim rows parked in the future", async () => {
    await enqueue({ next_attempt_at: "2199-01-01T00:00:00Z" })
    expect(await claimBatch(5)).toEqual([])
  })

  it("does not claim rows that are not pending", async () => {
    await enqueue({ status: "processing" })
    await enqueue({ status: "succeeded" })
    await enqueue({ status: "dead" })
    expect(await claimBatch(5)).toEqual([])
  })
})

describe("mark_tag_queue_row_started (real SQL)", () => {
  it("stamps started_at and increments attempt_count for a claimed row", async () => {
    const id = await enqueue()
    await claimBatch(1)

    const started = await markStarted(id)
    expect(started.attempt_count).toBe(1)
    expect(started.started_at).not.toBeNull()

    const row = await queueRowById(id)
    expect(row.attempt_count).toBe(1)
    expect(row.started_at).not.toBeNull()
  })

  it("returns an all-null row (no match) when called on a row that is not processing/unstarted", async () => {
    const id = await enqueue() // still pending — never claimed
    const [row] = await db.query<{ id: number | null; attempt_count: number | null }>(
      "SELECT id::int AS id, attempt_count FROM public.mark_tag_queue_row_started($1::bigint)",
      [id]
    )
    expect(row?.id).toBeNull()
    expect((await queueRowById(id)).attempt_count).toBe(0)
  })

  it("does not double-stamp a row that was already marked started", async () => {
    const id = await enqueue()
    await claimBatch(1)
    await markStarted(id)

    const [again] = await db.query<{ id: number | null }>(
      "SELECT id::int AS id FROM public.mark_tag_queue_row_started($1::bigint)",
      [id]
    )
    expect(again?.id).toBeNull()
    expect((await queueRowById(id)).attempt_count).toBe(1)
  })
})

describe("release_unstarted_tag_queue_rows (real SQL)", () => {
  it("returns unstarted claims to pending", async () => {
    const id = await enqueue()
    await claimBatch(1)

    expect(await releaseUnstarted([id])).toBe(1)
    const queueRow = await queueRowById(id)
    expect(queueRow.status).toBe("pending")
    expect(queueRow.started_at).toBeNull()
  })

  it("does not release a row that was already marked started", async () => {
    const id = await enqueue()
    await claimBatch(1)
    await markStarted(id)

    expect(await releaseUnstarted([id])).toBe(0)
    expect((await queueRowById(id)).status).toBe("processing")
  })
})

describe("reap_stuck_tag_queue_rows (real SQL)", () => {
  it("reaps rows stuck in processing with started_at over 15 minutes old", async () => {
    const id = await enqueue({ status: "processing", started_at: "2026-06-01T00:00:00Z" })

    expect(await reapStuck()).toBe(1)
    const queueRow = await queueRowById(id)
    expect(queueRow.status).toBe("pending")
    expect(queueRow.started_at).toBeNull()
    expect(queueRow.last_error).toBe("reaped after stuck in processing")
  })

  it("does NOT reap rows claimed recently even if next_attempt_at is stale (fixes race)", async () => {
    // Claim stamps claimed_at = now(). A row whose next_attempt_at is overdue but whose
    // claimed_at is fresh should NOT be reaped (fixes the race where freshly claimed
    // overdue rows were instantly reap-eligible).
    const id = await enqueue({
      status: "processing",
      started_at: null,
      next_attempt_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    })
    // Manually update claimed_at to fresh timestamp (simulating recent claim)
    await db.query(
      "UPDATE public.event_tag_queue SET claimed_at = now() WHERE id = $1::bigint",
      [id]
    )

    expect(await reapStuck()).toBe(0)
    expect((await queueRowById(id)).status).toBe("processing")
  })

  it("reaps rows stuck unstarted with a stale claimed_at over 5 minutes old", async () => {
    // Now the reaper checks claimed_at (set by claim) not just next_attempt_at.
    const id = await enqueue({
      status: "processing",
      started_at: null,
    })
    // Manually backdate claimed_at to >5 minutes ago
    await db.query(
      "UPDATE public.event_tag_queue SET claimed_at = $1::timestamptz WHERE id = $2::bigint",
      [new Date(Date.now() - 10 * 60_000).toISOString(), id]
    )

    expect(await reapStuck()).toBe(1)
    expect((await queueRowById(id)).status).toBe("pending")
  })

  it("reaps rows with NULL claimed_at and stale next_attempt_at (COALESCE fallback)", async () => {
    // COALESCE(claimed_at, next_attempt_at) covers rows already in-flight when the migration landed.
    const id = await enqueue({
      status: "processing",
      started_at: null,
      next_attempt_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    })
    // Manually set claimed_at to NULL (simulating pre-migration row)
    await db.query(
      "UPDATE public.event_tag_queue SET claimed_at = NULL WHERE id = $1::bigint",
      [id]
    )

    expect(await reapStuck()).toBe(1)
    expect((await queueRowById(id)).status).toBe("pending")
  })

  it("does not touch rows recently claimed and not yet stuck", async () => {
    const id = await enqueue({ status: "processing", started_at: null })

    expect(await reapStuck()).toBe(0)
    expect((await queueRowById(id)).status).toBe("processing")
  })

  it("preserves an existing last_error instead of overwriting it", async () => {
    const id = await enqueue({
      status: "processing",
      started_at: "2026-06-01T00:00:00Z",
      last_error: "previous failure",
    })

    await reapStuck()
    expect((await queueRowById(id)).last_error).toBe("previous failure")
  })
})
