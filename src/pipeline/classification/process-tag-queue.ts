// Tag-queue batch worker: reaps stuck rows, claims a batch (default 20),
// marks each claimed row started, runs tag-event per row with bounded
// concurrency (4), applies the exponential-backoff retry ladder
// (1/2/4/8/16 min via next_attempt_at, dead-letter at MAX_ATTEMPTS=5,
// Sentry on dead-letter only), releases unstarted rows once the wall-clock
// budget is nearly spent, and reports whether more work remains.
// Ported from family-events-backend supabase/functions/process-tag-queue/index.ts (U29).
// Deviations:
// - The SupabaseClient parameter became the narrow TagQueueDb seam (pg throws
//   instead of returning `{ data, error }`); every `const { error } = ...; if
//   (error) throw error` check became a plain awaited seam call, mirroring
//   U28's ProcessSourceDb/SourceQueueDb split. The repository implementation
//   over `pg` is a separate PR; tests here use a recording fake.
// - cronRunContextFromRequest/logCronRunEvent were dropped entirely (U28
//   precedent from process-source.ts/source-queue.worker.ts): every log call
//   site uses logEdgeEvent directly. Scheduled-run history and the kill
//   switch now live on CronGateService at the pg-boss service layer, outside
//   this pure batch worker.
// - callTagEvent's invokeFunction HTTP call to the tag-event edge function
//   became the injected TagQueueWorkerDependencies.runTagEvent(input)
//   dependency; the exact success/failure/status handling around it
//   (soft-success on missing title, thrown-error -> retry/dead-letter
//   routing) is unchanged. The pg-boss wiring PR supplies the real
//   implementation backed by the ported tag-event handler.
//   PER_ITEM_TIMEOUT_MS (an HTTP fetch timeout) is dropped here — timeout
//   policy now belongs to whatever runTagEvent implementation is injected.
// - The self-chain `invoke_process_tag_queue` RPC call was replaced with a
//   `moreWork: boolean` field on the returned summary, computed with the
//   exact same guard (pendingAfter > 0 && claimed > 0 && failed < claimed).
//   No HTTP or RPC kick happens in this module — the pg-boss registration PR
//   chains the next batch from `moreWork`, mirroring U28's
//   drain-source-queue precedent (ScrapeQueueService.drainSourceQueue).
// - markSuccess's status write still calls resolveCompletedTagQueueStatus()
//   from queue-policy.ts at the same call sites (both the normal-success and
//   missing-event soft-success paths), now via
//   TagQueueDb.completeTagQueueRow(rowId, status).
// - ProcessSummary fields were renamed to camelCase (claimed, reaped,
//   succeeded, failed, dead, pendingAfter, durationMs, moreWork) to match
//   house style (U28 ProcessSourceQueueResult / drain summary).
// - normalizeEventInputs (Supabase `unknown`-field coercion) is dropped: the
//   TagQueueDb seam returns already-typed EventInputs; that coercion now
//   belongs to the repository implementation.
// - prefetchEventInputs's swallow-error-to-empty-Map behavior is preserved by
//   contract (TagQueueDb.fetchEventInputsBulk never throws in the reference
//   repository), not re-implemented here — the seam boundary is the trust
//   line.

import { errorContext, errorMessage, logEdgeEvent } from "../logger.js"
import { captureEdgeException } from "../sentry.js"
import {
  resolveCompletedTagQueueStatus,
  shouldStopBeforeStartingNextTagRow,
  type TagQueueStatus,
} from "./queue-policy.js"

// Retry policy (unchanged from the legacy plan):
//   - exponential backoff (1, 2, 4, 8, 16 min) via next_attempt_at
//   - dead-letter after MAX_ATTEMPTS=5
//   - Sentry on dead-letter only (avoid noise from transient LLM/provider 5xx)
const MAX_ATTEMPTS = 5
const BASE_BACKOFF_MS = 60_000
const BATCH_SIZE = 20
const CONCURRENCY = 4
// Wall-clock budget for one batch invocation; shouldStopBeforeStartingNextTagRow
// leaves a 5s margin before this to release the rest of the batch instead of
// starting more work we can't finish.
const BATCH_WALL_BUDGET_MS = 110_000

export interface TagQueueRow {
  id: number
  event_id: string
  source_run_id: string | null
  trigger_type: "import" | "reclassify" | "manual-review"
  attempt_count: number
}

export interface EventInputs {
  title: string
  description: string
}

export interface TagEventInput {
  eventId: string
  sourceRunId: string | null
  triggerType: TagQueueRow["trigger_type"]
  title: string
  description: string
}

/** Runs tag-event for one row; throws on failure (transient or hard). */
export type RunTagEvent = (input: TagEventInput) => Promise<void>

export interface TagQueueWorkerDependencies {
  runTagEvent: RunTagEvent
}

export interface TagQueueBatchSummary {
  claimed: number
  reaped: number
  succeeded: number
  failed: number
  dead: number
  pendingAfter: number | null
  durationMs: number
  /** True when the pg-boss wiring should chain another batch immediately. */
  moreWork: boolean
}

/**
 * Queue-side DB operations the legacy Supabase RPCs/queries covered.
 * Implemented by a repository over `pg` (separate PR); throws on error.
 */
export interface TagQueueDb {
  /** reap_stuck_tag_queue_rows RPC. */
  reapStuckTagQueueRows(): Promise<number>
  /** claim_tag_queue_batch RPC (p_limit). */
  claimTagQueueBatch(limit: number): Promise<TagQueueRow[]>
  /** mark_tag_queue_row_started RPC (p_queue_id); returns the row with its incremented attempt_count. */
  markTagQueueRowStarted(queueId: number): Promise<TagQueueRow>
  /** release_unstarted_tag_queue_rows RPC (p_claimed_ids). */
  releaseUnstartedTagQueueRows(claimedIds: number[]): Promise<void>
  /** Single-row events.title/description lookup — fallback for rows missing from the bulk prefetch. */
  fetchEventInputs(eventId: string): Promise<EventInputs | null>
  /** Bulk events.title/description lookup for every claimed row's event_id in one round-trip. */
  fetchEventInputsBulk(eventIds: string[]): Promise<Map<string, EventInputs>>
  /** event_tag_queue completion write (status, finished_at, last_error=null). */
  completeTagQueueRow(rowId: number, status: TagQueueStatus): Promise<void>
  /** event_tag_queue dead-letter write (status='dead', finished_at, last_error). */
  markTagQueueRowDead(rowId: number, error: string): Promise<void>
  /** event_tag_queue retry write (status='pending', started_at=null, next_attempt_at, last_error). */
  scheduleTagQueueRetry(rowId: number, nextAttemptAt: string, error: string): Promise<void>
  /** count of event_tag_queue rows with status='pending', snapshotted after the batch. */
  countPendingTagQueueRows(): Promise<number>
}

async function markFailureOrDead(
  db: TagQueueDb,
  row: TagQueueRow,
  err: unknown
): Promise<{ dead: boolean }> {
  const errMsg = errorMessage(err)
  const attempts = row.attempt_count // already incremented by markTagQueueRowStarted
  const isDead = attempts >= MAX_ATTEMPTS

  if (isDead) {
    await db.markTagQueueRowDead(row.id, errMsg.slice(0, 1000))
    return { dead: true }
  }

  // Exponential backoff. attempts=1 -> 1 min, attempts=2 -> 2 min, ... attempts=4 -> 8 min.
  const backoffMs = BASE_BACKOFF_MS * Math.pow(2, attempts - 1)
  const nextAttemptAt = new Date(Date.now() + backoffMs).toISOString()
  await db.scheduleTagQueueRetry(row.id, nextAttemptAt, errMsg.slice(0, 1000))
  return { dead: false }
}

// Process one row in an isolated try/catch so a single failure doesn't poison
// its chunk. Mutates `summary` in place; returned as an awaitable for
// Promise.all.
async function processOneRow(
  db: TagQueueDb,
  runTagEvent: RunTagEvent,
  eventInputsById: Map<string, EventInputs>,
  summary: TagQueueBatchSummary,
  row: TagQueueRow
): Promise<void> {
  const rowStart = Date.now()
  let activeRow = row
  try {
    const startedRow = await db.markTagQueueRowStarted(row.id)
    activeRow = { ...row, attempt_count: startedRow.attempt_count }

    // Read from the prefetched Map; fall back to a single fetch only when the
    // event was absent from the prefetch (preserves the original resilience).
    const inputs = eventInputsById.has(activeRow.event_id)
      ? (eventInputsById.get(activeRow.event_id) ?? null)
      : await db.fetchEventInputs(activeRow.event_id)

    if (!inputs || !inputs.title) {
      // Event was deleted between enqueue and claim, or has no title.
      // Don't retry -- mark as a soft completion.
      await db.completeTagQueueRow(activeRow.id, resolveCompletedTagQueueStatus())
      summary.succeeded += 1
      logEdgeEvent("log", "tag-queue row skipped (event missing)", {
        function: "process-tag-queue",
        queueRowId: activeRow.id,
        eventId: activeRow.event_id,
        attempt: activeRow.attempt_count,
        durationMs: Date.now() - rowStart,
        outcome: "skipped-missing-event",
      })
      return
    }

    await runTagEvent({
      eventId: activeRow.event_id,
      sourceRunId: activeRow.source_run_id,
      triggerType: activeRow.trigger_type,
      title: inputs.title,
      description: inputs.description,
    })
    await db.completeTagQueueRow(activeRow.id, resolveCompletedTagQueueStatus())
    summary.succeeded += 1
    logEdgeEvent("log", "tag-queue row processed", {
      function: "process-tag-queue",
      queueRowId: activeRow.id,
      eventId: activeRow.event_id,
      attempt: activeRow.attempt_count,
      durationMs: Date.now() - rowStart,
      titleChars: inputs.title.length,
      descriptionChars: inputs.description.length,
      outcome: "succeeded",
    })
  } catch (err) {
    const { dead } = await markFailureOrDead(db, activeRow, err).catch((markErr: unknown) => {
      // Updating the row itself failed -- log loudly so we notice in Sentry.
      void captureEdgeException(
        markErr,
        errorContext(markErr, {
          function: "process-tag-queue",
          queueRowId: activeRow.id,
          eventId: activeRow.event_id,
          stage: "mark-failure",
        })
      )
      return { dead: false }
    })

    if (dead) {
      summary.dead += 1
      await captureEdgeException(
        err,
        errorContext(err, {
          function: "process-tag-queue",
          queueRowId: activeRow.id,
          eventId: activeRow.event_id,
          attempts: activeRow.attempt_count,
          status: "dead",
        })
      )
      logEdgeEvent(
        "error",
        "tag-queue row dead-lettered",
        errorContext(err, {
          function: "process-tag-queue",
          queueRowId: activeRow.id,
          eventId: activeRow.event_id,
          attempts: activeRow.attempt_count,
          durationMs: Date.now() - rowStart,
          outcome: "dead",
        })
      )
    } else {
      summary.failed += 1
      // Transient failures intentionally NOT captured to Sentry to avoid
      // noise during provider/edge outages. The queue row itself preserves
      // last_error for inspection.
      logEdgeEvent("warn", "tag-queue row retry scheduled", {
        function: "process-tag-queue",
        queueRowId: activeRow.id,
        eventId: activeRow.event_id,
        attempt: activeRow.attempt_count,
        durationMs: Date.now() - rowStart,
        error: errorMessage(err).slice(0, 300),
        outcome: "retry",
      })
    }
  }
}

/**
 * One tag-queue batch: reap stuck rows, claim up to BATCH_SIZE, process them
 * CONCURRENCY-at-a-time, release whatever's left when the wall budget is
 * nearly spent, and report whether the pg-boss wiring should chain another
 * batch immediately.
 */
export async function processTagQueueBatch(
  db: TagQueueDb,
  dependencies: TagQueueWorkerDependencies
): Promise<TagQueueBatchSummary> {
  const batchStart = Date.now()
  const summary: TagQueueBatchSummary = {
    claimed: 0,
    reaped: 0,
    succeeded: 0,
    failed: 0,
    dead: 0,
    pendingAfter: null,
    durationMs: 0,
    moreWork: false,
  }

  summary.reaped = await db.reapStuckTagQueueRows()

  const rows = await db.claimTagQueueBatch(BATCH_SIZE)
  summary.claimed = rows.length

  if (rows.length === 0) {
    summary.durationMs = Date.now() - batchStart
    logEdgeEvent("log", "tag-queue batch done", { function: "process-tag-queue", ...summary })
    return summary
  }

  // Prefetch all claimed events' inputs in one round-trip instead of one
  // lookup per row inside the parallel chunk loop.
  const eventInputsById = await db.fetchEventInputsBulk([...new Set(rows.map((r) => r.event_id))])

  // Run CONCURRENCY rows in parallel per chunk. Each row is independent --
  // Promise.all serializes the wait, not the work. The wall budget check runs
  // before each chunk so we release the rest of the batch if a previous
  // chunk took unexpectedly long, instead of starting more work we can't
  // finish.
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    if (shouldStopBeforeStartingNextTagRow(Date.now() - batchStart, BATCH_WALL_BUDGET_MS)) {
      const unstartedRowIds = rows.slice(i).map((item) => item.id)
      if (unstartedRowIds.length > 0) {
        await db.releaseUnstartedTagQueueRows(unstartedRowIds)
      }
      break
    }
    const chunk = rows.slice(i, i + CONCURRENCY)
    await Promise.all(
      chunk.map((row) => processOneRow(db, dependencies.runTagEvent, eventInputsById, summary, row))
    )
  }

  // Snapshot queue depth after the batch so dashboards aren't the only signal.
  summary.pendingAfter = await db.countPendingTagQueueRows()
  summary.durationMs = Date.now() - batchStart

  logEdgeEvent("log", "tag-queue batch done", { function: "process-tag-queue", ...summary })

  // Guards against runaway (unchanged from the legacy self-chain guard):
  //   - require pendingAfter > 0 (no work -> stop)
  //   - require claimed > 0 (no progress this tick -> stop, let the next
  //     scheduled tick retry)
  //   - require failed < claimed (don't loop on persistent errors)
  summary.moreWork =
    (summary.pendingAfter ?? 0) > 0 && summary.claimed > 0 && summary.failed < summary.claimed

  return summary
}
