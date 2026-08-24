import { describe, expect, it } from "vitest"

import { EMBEDDING_DIMENSIONS } from "./embed-event.js"
import {
  processEmbeddingsBackfill,
  type EmbeddingsBackfillDb,
  type EmbeddingsBackfillSummary,
} from "./process-embeddings-backfill.js"

// Ported from family-events-backend supabase/functions/backfill-embeddings/index.ts:48-140 (U29).

interface FakeEventRow {
  id: string
  title: string | null
  description: string | null
}

class FakeEmbeddingsBackfillDb implements EmbeddingsBackfillDb {
  events: FakeEventRow[] = []
  listCalls: number[] = []
  upserts: Array<{ eventId: string; embedding: number[]; model: string }> = []

  async listEventsNeedingEmbeddings(limit: number): Promise<FakeEventRow[]> {
    this.listCalls.push(limit)
    return this.events.slice(0, limit)
  }

  async upsertEventEmbedding(eventId: string, embedding: number[], model: string): Promise<void> {
    this.upserts.push({ eventId, embedding, model })
  }
}

function okResponse(vector: number[] = Array(EMBEDDING_DIMENSIONS).fill(0.1)) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: [{ embedding: vector, index: 0 }] }),
  }
}

function errorResponse(status = 500, body = "boom") {
  return { ok: false, status, text: async () => body }
}

function fetchQueue(responses: Array<() => unknown>): typeof fetch {
  let index = 0
  return (async () => {
    const handler = responses[index] ?? responses[responses.length - 1]
    index += 1
    return handler!()
  }) as unknown as typeof fetch
}

function recordingSleep(): { sleep: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = []
  return {
    calls,
    sleep: async (ms: number) => {
      calls.push(ms)
    },
  }
}

function clockFrom(values: number[]): () => number {
  let index = 0
  return () => values[Math.min(index++, values.length - 1)]!
}

describe("processEmbeddingsBackfill", () => {
  it("returns a zeroed summary and never enters the loop when nothing is found", async () => {
    const db = new FakeEmbeddingsBackfillDb()
    const { sleep, calls } = recordingSleep()

    const summary = await processEmbeddingsBackfill(db, {
      apiKey: "sk-test",
      sleep,
      now: clockFrom([0, 5]),
    })

    expect(summary).toEqual({ totalFound: 0, processed: 0, failed: 0, skipped: 0, durationMs: 5 })
    expect(calls).toHaveLength(0)
    expect(db.listCalls).toEqual([50])
  })

  it("fetches exactly one batch sized by batchSize (no self-loop)", async () => {
    const db = new FakeEmbeddingsBackfillDb()
    db.events = [{ id: "e1", title: "Story", description: null }]
    const { sleep } = recordingSleep()
    const fetchImpl = fetchQueue([() => okResponse()])

    await processEmbeddingsBackfill(db, { apiKey: "sk-test", sleep, fetchImpl, batchSize: 10 })

    expect(db.listCalls).toEqual([10])
  })

  it("skips blank/whitespace titles without embedding or sleeping, and processes valid ones", async () => {
    const db = new FakeEmbeddingsBackfillDb()
    db.events = [
      { id: "e1", title: "  ", description: null },
      { id: "e2", title: null, description: null },
      { id: "e3", title: "Story Time", description: "fun" },
    ]
    const { sleep, calls } = recordingSleep()
    const fetchImpl = fetchQueue([() => okResponse()])

    const summary = await processEmbeddingsBackfill(db, {
      apiKey: "sk-test",
      sleep,
      fetchImpl,
      delayMs: 25,
    })

    expect(summary).toMatchObject({ totalFound: 3, processed: 1, failed: 0, skipped: 2 })
    expect(db.upserts.map((u) => u.eventId)).toEqual(["e3"])
    // Only one sleep call: the two skipped items `continue` before reaching
    // the delay, matching legacy backfill-embeddings/index.ts:101-105.
    expect(calls).toEqual([25])
  })

  it("increments failed and continues when embedEvent throws, and still sleeps after a failure", async () => {
    const db = new FakeEmbeddingsBackfillDb()
    db.events = [
      { id: "e1", title: "Bad", description: null },
      { id: "e2", title: "Good", description: null },
    ]
    const { sleep, calls } = recordingSleep()
    const fetchImpl = fetchQueue([() => errorResponse(500, "boom"), () => okResponse()])

    const summary = await processEmbeddingsBackfill(db, {
      apiKey: "sk-test",
      sleep,
      fetchImpl,
      delayMs: 10,
    })

    expect(summary).toMatchObject({ totalFound: 2, processed: 1, failed: 1, skipped: 0 })
    expect(db.upserts.map((u) => u.eventId)).toEqual(["e2"])
    // Legacy sleeps unconditionally after the try/catch, so a failure still
    // sleeps (index.ts:107-129).
    expect(calls).toEqual([10, 10])
  })

  it("sleeps after the last processed item too (legacy has no last-item guard)", async () => {
    const db = new FakeEmbeddingsBackfillDb()
    db.events = [{ id: "e1", title: "Solo", description: null }]
    const { sleep, calls } = recordingSleep()
    const fetchImpl = fetchQueue([() => okResponse()])

    await processEmbeddingsBackfill(db, { apiKey: "sk-test", sleep, fetchImpl, delayMs: 15 })

    expect(calls).toEqual([15])
  })

  it("stops early once elapsed time reaches the budget, leaving later events unprocessed", async () => {
    const db = new FakeEmbeddingsBackfillDb()
    db.events = [
      { id: "e1", title: "One", description: null },
      { id: "e2", title: "Two", description: null },
      { id: "e3", title: "Three", description: null },
    ]
    const { sleep } = recordingSleep()
    const fetchImpl = fetchQueue([() => okResponse()])
    // now() sequence: startedAt=0; iter1 elapsed=0 (process e1); iter2
    // elapsed=110_000 (budget hit) -> break before e2/e3; final duration calc.
    const now = clockFrom([0, 0, 110_000, 110_000])

    const summary = await processEmbeddingsBackfill(db, {
      apiKey: "sk-test",
      sleep,
      fetchImpl,
      now,
      budgetMs: 110_000,
    })

    expect(summary.processed).toBe(1)
    expect(summary.totalFound).toBe(3)
    expect(summary.failed).toBe(0)
    expect(summary.skipped).toBe(0)
    expect(db.upserts.map((u) => u.eventId)).toEqual(["e1"])
  })

  it("returns the exact summary shape with durationMs computed from now()", async () => {
    const db = new FakeEmbeddingsBackfillDb()
    db.events = [{ id: "e1", title: "Solo", description: null }]
    const { sleep } = recordingSleep()
    const fetchImpl = fetchQueue([() => okResponse()])
    const now = clockFrom([1000, 1000, 1500])

    const summary: EmbeddingsBackfillSummary = await processEmbeddingsBackfill(db, {
      apiKey: "sk-test",
      sleep,
      fetchImpl,
      now,
    })

    expect(summary).toEqual({ totalFound: 1, processed: 1, failed: 0, skipped: 0, durationMs: 500 })
  })
})
