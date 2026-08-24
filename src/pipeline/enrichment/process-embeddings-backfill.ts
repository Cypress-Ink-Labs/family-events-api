// Embeddings-backfill batch worker: pulls events missing embeddings, embeds
// each one via `embedEvent`, and tracks processed/failed/skipped counts
// within a wall-clock budget.
// Ported from family-events-backend supabase/functions/backfill-embeddings/index.ts
// lines 48-140 (`backfillEmbeddings`) (U29).
// Deviations:
// - The Supabase client + `findEventsWithoutEmbeddings` RPC call become the
//   `EmbeddingsBackfillDb.listEventsNeedingEmbeddings` seam
//   (public.list_events_needing_embeddings); the repository implementation is
//   a separate task (worker purity: no pg here).
// - `sleep` is injectable via `EmbeddingsBackfillDependencies.sleep` (defaults
//   to a real setTimeout-based sleep) so unit tests don't wait on wall-clock
//   time; legacy hard-coded a local `sleep` helper.
// - Summary field names are camelCase (totalFound/durationMs) to match this
//   codebase's convention; legacy used snake_case (total_found/duration_ms).
// - Loop/skip/failure/budget semantics are ported exactly: the budget is
//   checked before processing each item (not after), a blank title `continue`s
//   before the rate-limit delay (skips do not sleep), and a failure still
//   falls through to the delay after the try/catch (failures do sleep) —
//   matching index.ts:90-130 verbatim, including the lack of a "last item"
//   guard around the sleep call.

import { logEdgeEvent } from "../logger.js"
import { embedEvent, type EmbedEventDb } from "./embed-event.js"

const BATCH_SIZE = 50
const DELAY_BETWEEN_ITEMS_MS = 50 // ~1200/min, well under OpenAI 3000 RPM
const BUDGET_MS = 110_000 // Stop before edge function 150s wall limit

export interface EmbeddingsBackfillDb extends EmbedEventDb {
  /** public.list_events_needing_embeddings(p_limit) */
  listEventsNeedingEmbeddings(
    limit: number
  ): Promise<Array<{ id: string; title: string | null; description: string | null }>>
}

export interface EmbeddingsBackfillSummary {
  totalFound: number
  processed: number
  failed: number
  skipped: number
  durationMs: number
}

export interface EmbeddingsBackfillDependencies {
  apiKey: string
  /** Legacy BATCH_SIZE = 50. */
  batchSize?: number
  /** Legacy DELAY_BETWEEN_ITEMS_MS = 50. */
  delayMs?: number
  /** Legacy BUDGET_MS = 110_000. */
  budgetMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  fetchImpl?: typeof fetch
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * One backfill batch: fetch up to `batchSize` events needing embeddings,
 * embed each within the wall-clock budget. One batch only — no self-loop;
 * callers are responsible for scheduling the next invocation.
 */
export async function processEmbeddingsBackfill(
  db: EmbeddingsBackfillDb,
  deps: EmbeddingsBackfillDependencies
): Promise<EmbeddingsBackfillSummary> {
  const batchSize = deps.batchSize ?? BATCH_SIZE
  const delayMs = deps.delayMs ?? DELAY_BETWEEN_ITEMS_MS
  const budgetMs = deps.budgetMs ?? BUDGET_MS
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? defaultSleep
  const startedAt = now()

  const summary: EmbeddingsBackfillSummary = {
    totalFound: 0,
    processed: 0,
    failed: 0,
    skipped: 0,
    durationMs: 0,
  }

  const events = await db.listEventsNeedingEmbeddings(batchSize)
  summary.totalFound = events.length

  if (events.length === 0) {
    summary.durationMs = now() - startedAt
    logEdgeEvent("log", "backfill-embeddings: nothing to do", {
      function: "backfill-embeddings",
      ...summary,
    })
    return summary
  }

  for (const event of events) {
    const elapsed = now() - startedAt
    if (elapsed >= budgetMs) {
      logEdgeEvent("warn", "backfill-embeddings: budget exhausted", {
        function: "backfill-embeddings",
        elapsed_ms: elapsed,
        processed: summary.processed,
        remaining: summary.totalFound - summary.processed - summary.failed - summary.skipped,
      })
      break
    }

    const title = event.title
    if (!title?.trim()) {
      summary.skipped += 1
      continue
    }

    try {
      await embedEvent(
        db,
        { eventId: event.id, title, description: event.description },
        { apiKey: deps.apiKey, fetchImpl: deps.fetchImpl }
      )
      summary.processed += 1
    } catch (err) {
      summary.failed += 1
      logEdgeEvent("warn", "backfill-embeddings: item failed", {
        function: "backfill-embeddings",
        event_id: event.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // Rate limit delay between items.
    if (delayMs > 0) {
      await sleep(delayMs)
    }
  }

  summary.durationMs = now() - startedAt

  logEdgeEvent("log", "backfill-embeddings: batch complete", {
    function: "backfill-embeddings",
    ...summary,
  })

  return summary
}
