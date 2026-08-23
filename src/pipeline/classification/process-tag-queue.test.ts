import { describe, expect, it } from "vitest"

import {
  processTagQueueBatch,
  type EventInputs,
  type RunTagEvent,
  type TagEventInput,
  type TagQueueBatchSummary,
  type TagQueueDb,
  type TagQueueRow,
} from "./process-tag-queue.js"
import type { TagQueueStatus } from "./queue-policy.js"

// Ported from family-events-backend supabase/functions/process-tag-queue/index_test.ts
// (U29), converted from Deno.test to vitest. The Supabase client mock became a
// FakeTagQueueDb implementing the TagQueueDb seam; the fetch-mocked tag-event
// HTTP call became a recording RunTagEvent fake. Every scenario and expected
// value is unchanged; assertions on the outgoing HTTP request (URL, auth
// header) are replaced with an assertion on the TagEventInput payload passed
// to runTagEvent, and the `invoke_process_tag_queue` RPC assertions became
// assertions on the returned `moreWork` boolean.

class FakeTagQueueDb implements TagQueueDb {
  reaped = 0
  claimedRows: TagQueueRow[] = []
  startedAttempts = new Map<number, number>()
  events = new Map<string, EventInputs>()
  pendingCount = 0
  calls: string[] = []
  updates = new Map<number, Record<string, unknown>>()
  eventBulkSelects: string[][] = []
  eventSingleSelects: string[] = []
  releaseCalls: number[][] = []

  async reapStuckTagQueueRows(): Promise<number> {
    this.calls.push("reapStuckTagQueueRows")
    return this.reaped
  }

  async claimTagQueueBatch(limit: number): Promise<TagQueueRow[]> {
    this.calls.push("claimTagQueueBatch")
    return this.claimedRows.slice(0, limit)
  }

  async markTagQueueRowStarted(queueId: number): Promise<TagQueueRow> {
    this.calls.push("markTagQueueRowStarted")
    const claimedRow = this.claimedRows.find((candidate) => candidate.id === queueId)
    const attemptCount = this.startedAttempts.get(queueId) ?? (claimedRow?.attempt_count ?? 0) + 1
    return {
      ...(claimedRow ?? {
        id: queueId,
        event_id: "",
        source_run_id: null,
        trigger_type: "import",
        attempt_count: 0,
      }),
      attempt_count: attemptCount,
    }
  }

  async releaseUnstartedTagQueueRows(claimedIds: number[]): Promise<void> {
    this.calls.push("releaseUnstartedTagQueueRows")
    this.releaseCalls.push(claimedIds)
  }

  async fetchEventInputs(eventId: string): Promise<EventInputs | null> {
    this.calls.push("fetchEventInputs")
    this.eventSingleSelects.push(eventId)
    return this.events.get(eventId) ?? null
  }

  async fetchEventInputsBulk(eventIds: string[]): Promise<Map<string, EventInputs>> {
    this.calls.push("fetchEventInputsBulk")
    this.eventBulkSelects.push(eventIds)
    const map = new Map<string, EventInputs>()
    for (const id of eventIds) {
      const event = this.events.get(id)
      if (event) map.set(id, event)
    }
    return map
  }

  async completeTagQueueRow(rowId: number, status: TagQueueStatus): Promise<void> {
    this.calls.push("completeTagQueueRow")
    this.updates.set(rowId, { status, finished_at: new Date().toISOString(), last_error: null })
  }

  async markTagQueueRowDead(rowId: number, error: string): Promise<void> {
    this.calls.push("markTagQueueRowDead")
    this.updates.set(rowId, {
      status: "dead",
      finished_at: new Date().toISOString(),
      last_error: error,
    })
  }

  async scheduleTagQueueRetry(rowId: number, nextAttemptAt: string, error: string): Promise<void> {
    this.calls.push("scheduleTagQueueRetry")
    this.updates.set(rowId, {
      status: "pending",
      started_at: null,
      next_attempt_at: nextAttemptAt,
      last_error: error,
    })
  }

  async countPendingTagQueueRows(): Promise<number> {
    this.calls.push("countPendingTagQueueRows")
    return this.pendingCount
  }
}

function row(id: number, overrides: Partial<TagQueueRow> = {}): TagQueueRow {
  return {
    id,
    event_id: `evt-${id}`,
    source_run_id: `run-${id}`,
    trigger_type: "import",
    attempt_count: 0,
    ...overrides,
  }
}

// ── Shared fixtures ──────────────────────────────────────────────────────────

const STORYTIME_EVENT: EventInputs = { title: "Storytime", description: "Books" }

// Fake preloaded with the claimed rows plus a Storytime event input per row —
// the setup almost every scenario starts from; tests mutate from there
// (attempt counts, pending count, custom event inputs).
function seededDb(rows: TagQueueRow[]): FakeTagQueueDb {
  const db = new FakeTagQueueDb()
  db.claimedRows = rows
  for (const item of rows) {
    db.events.set(item.event_id, { ...STORYTIME_EVENT })
  }
  return db
}

// Runs one batch with the default recording runTagEvent (calls collects every
// TagEventInput) or with a caller-supplied implementation (throwing stubs).
async function runBatch(
  db: FakeTagQueueDb,
  runTagEvent?: RunTagEvent
): Promise<{ summary: TagQueueBatchSummary; calls: TagEventInput[] }> {
  const calls: TagEventInput[] = []
  const summary = await processTagQueueBatch(db, {
    runTagEvent:
      runTagEvent ??
      (async (input) => {
        calls.push(input)
      }),
  })
  return { summary, calls }
}

describe("processTagQueueBatch", () => {
  it("returns after an empty claim", async () => {
    const db = new FakeTagQueueDb()
    db.reaped = 2

    const { summary, calls } = await runBatch(db)

    expect(summary.claimed).toBe(0)
    expect(summary.reaped).toBe(2)
    expect(summary.pendingAfter).toBe(null)
    expect(db.calls).toEqual(["reapStuckTagQueueRows", "claimTagQueueBatch"])
    expect(calls).toEqual([])
  })

  it("tags a claimed row and reports more work remaining", async () => {
    const db = seededDb([row(1)])
    db.pendingCount = 3

    const { summary, calls } = await runBatch(db)

    expect(summary.claimed).toBe(1)
    expect(summary.succeeded).toBe(1)
    expect(summary.failed).toBe(0)
    expect(summary.dead).toBe(0)
    expect(summary.moreWork).toBe(true)

    expect(calls).toEqual([
      {
        eventId: "evt-1",
        sourceRunId: "run-1",
        triggerType: "import",
        title: "Storytime",
        description: "Books",
      },
    ])
    expect(db.updates.get(1)?.status).toBe("succeeded")
  })

  it("treats missing titles as soft success", async () => {
    const db = seededDb([row(1)])
    db.events.set("evt-1", { title: "", description: "No usable title" })
    let runCount = 0

    const { summary } = await runBatch(db, async () => {
      runCount += 1
    })

    expect(summary.succeeded).toBe(1)
    expect(summary.failed).toBe(0)
    expect(runCount).toBe(0)
    expect(db.updates.get(1)?.status).toBe("succeeded")
  })

  it("schedules retry with backoff fields after transient failure", async () => {
    const db = seededDb([row(1)])
    db.startedAttempts.set(1, 2)
    db.pendingCount = 4

    const { summary } = await runBatch(db, async () => {
      throw new Error("tag-event 503: upstream")
    })

    expect(summary.failed).toBe(1)
    expect(summary.dead).toBe(0)
    expect(summary.moreWork).toBe(false)

    const update = db.updates.get(1)
    expect(update?.status).toBe("pending")
    expect(update?.started_at).toBe(null)
    expect(String(update?.last_error)).toContain("tag-event 503")
    expect(typeof update?.next_attempt_at).toBe("string")
  })

  it("dead-letters exhausted rows", async () => {
    const db = seededDb([row(1)])
    db.startedAttempts.set(1, 5)

    const { summary } = await runBatch(db, async () => {
      throw new Error("timeout")
    })

    expect(summary.failed).toBe(0)
    expect(summary.dead).toBe(1)

    const update = db.updates.get(1)
    expect(update?.status).toBe("dead")
    expect(String(update?.last_error)).toContain("timeout")
    expect(typeof update?.finished_at).toBe("string")
  })

  it("releases unstarted rows when the wall budget is nearly spent", async () => {
    const db = seededDb([row(1), row(2), row(3), row(4), row(5)])

    const originalNow = Date.now
    let now = 1_000
    Date.now = () => now

    try {
      const { summary } = await runBatch(db, async () => {
        now += 106_000
      })
      expect(summary.succeeded).toBe(4)
    } finally {
      Date.now = originalNow
    }

    expect(db.releaseCalls).toEqual([[5]])
  })

  it("aggregates a mixed batch (success + retry + dead)", async () => {
    // evt-1 succeeds, evt-2 fails transiently (attempt 2 -> retry), evt-3
    // fails at max attempts (attempt 5 -> dead). All three run in a single
    // chunk (CONCURRENCY=4); the per-row try/catch must keep them isolated so
    // one failure doesn't poison the others.
    const db = seededDb([row(1), row(2), row(3)])
    db.startedAttempts.set(2, 2) // under MAX_ATTEMPTS -> retry
    db.startedAttempts.set(3, 5) // at MAX_ATTEMPTS -> dead
    db.pendingCount = 0

    const { summary } = await runBatch(db, async (input) => {
      if (input.eventId === "evt-2") throw new Error("tag-event 503: upstream")
      if (input.eventId === "evt-3") throw new Error("hard timeout")
    })

    expect(summary.claimed).toBe(3)
    expect(summary.succeeded).toBe(1)
    expect(summary.failed).toBe(1)
    expect(summary.dead).toBe(1)

    expect(db.updates.get(1)?.status).toBe("succeeded")
    expect(db.updates.get(2)?.status).toBe("pending")
    expect(typeof db.updates.get(2)?.next_attempt_at).toBe("string")
    expect(db.updates.get(3)?.status).toBe("dead")
    expect(String(db.updates.get(3)?.last_error)).toContain("hard timeout")
  })

  it("prefetches all event inputs in a single bulk call", async () => {
    const db = seededDb([row(1), row(2), row(3)])
    db.pendingCount = 0

    const { summary } = await runBatch(db)
    expect(summary.succeeded).toBe(3)

    // Exactly one bulk prefetch covering all three event ids, and no per-row fallback.
    expect(db.eventBulkSelects).toEqual([["evt-1", "evt-2", "evt-3"]])
    expect(db.eventSingleSelects).toEqual([])
  })

  it("falls back to a single fetch for an event missing from the bulk prefetch", async () => {
    // Only evt-1 exists; evt-2 is absent from the prefetch result.
    const db = new FakeTagQueueDb()
    db.claimedRows = [row(1), row(2)]
    db.events.set("evt-1", { ...STORYTIME_EVENT })
    db.pendingCount = 0

    const { summary } = await runBatch(db)

    // evt-1 tags successfully; evt-2 has no event row -> soft success.
    expect(summary.succeeded).toBe(2)
    expect(summary.failed).toBe(0)

    // One bulk prefetch, plus a single fallback fetch for the missing evt-2 only.
    expect(db.eventBulkSelects).toEqual([["evt-1", "evt-2"]])
    expect(db.eventSingleSelects).toEqual(["evt-2"])
    // evt-2 resolved as a soft success (event missing).
    expect(db.updates.get(2)?.status).toBe("succeeded")
  })
})
