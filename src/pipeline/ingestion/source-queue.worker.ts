// Source-queue worker: claims one source_scrape_queue row (SKIP LOCKED via the
// claim RPC), runs deterministic extraction with optional LLM fallback,
// persists extraction traces, imports parsed events, and schedules retries
// with the 5/15/60-minute ladder (dead at attempt 4). Ported from
// family-events-backend supabase/functions/process-source-queue/lib/worker.ts
// plus processSourceQueueBatch from its index.ts (U28). Deviations:
// - The SupabaseClient became the SourceQueueDb seam (pg errors throw instead
//   of arriving in response objects; each `const { error } =` check became the
//   equivalent try/catch or plain await).
// - createAndLinkSourceRun composes two seam calls (insert run, link queue row)
//   instead of two supabase builder chains.
// - Upstream's default notifyFailure called the module-level sendFailurePing;
//   here Telegram config lives on the injectable FailurePingService, so
//   ScrapeQueueService supplies notifyFailure and the default dependencies
//   leave it unset (notifications silently skip, same as unset env upstream).

import { errorMessage, logEdgeEvent } from "../logger.js"
import { parsers } from "./parsers/index.js"
import { buildParserContext, importParsedSourceEvents } from "./process-source.js"
import type { ProcessSourceDb } from "./process-source.js"
import { validateParsedEvents } from "./extraction-pipeline.js"
import type {
  EventSourceRow,
  ExtractionMode,
  FetchedArtifact,
  ParsedEvent,
  SourceType,
} from "./types.js"
import type { SourceParser } from "./parsers/index.js"
import { extractWithLlm } from "./llm-extraction.js"

export interface SourceQueueRow {
  id: number
  source_id: string | null
  source_run_id: string | null
  attempt_count: number
}

export interface ProcessSourceQueueResult {
  outcome: "succeeded" | "retry" | "skipped"
  imported: number
}

export interface SourceFailureNotice {
  kind: "run_failed" | "dead_letter"
  sourceName: string
  error: string
}

export interface ExtractionTraceInsert {
  source_queue_id: number
  source_run_id: string
  source_id: string
  extraction_mode: ExtractionMode
  extractor: "deterministic" | "llm"
  status: "success" | "fallback" | "error"
  provider?: string
  model?: string
  input_bytes?: number
  parsed_event_count: number
  fallback_reason?: string | null
  latency_ms?: number
  reasoning_summary?: string
  error?: string
}

/**
 * Queue-side DB operations on top of the import path's seam. Mirrors the
 * supabase RPCs/queries the upstream worker issued; implemented by
 * IngestionRepository over the same public RPC wrappers PostgREST exposed.
 */
export interface SourceQueueDb extends ProcessSourceDb {
  reapStuckSourceScrapeQueueRows(): Promise<number>
  claimSourceScrapeQueueBatch(limit: number): Promise<SourceQueueRow[]>
  releaseUnstartedSourceScrapeQueueRows(claimedIds: number[]): Promise<number>
  markSourceScrapeQueueSkipped(queueId: number, reason: string): Promise<void>
  markSourceScrapeQueueStarted(queueId: number): Promise<SourceQueueRow>
  scheduleSourceScrapeRetry(queueId: number, attemptCount: number, error: string): Promise<void>
  markSourceScrapeQueueSucceeded(queueId: number): Promise<void>
  getEventSource(sourceId: string): Promise<EventSourceRow | null>
  /** cities.timezone or null — the worker applies its own America/Chicago fallback. */
  fetchCityTimezone(cityId: string): Promise<string | null>
  createSourceRun(sourceId: string): Promise<string>
  linkSourceRunToQueueRow(queueId: number, runId: string): Promise<void>
  insertExtractionTrace(row: ExtractionTraceInsert): Promise<void>
  markSourceRunError(runId: string, errorMessage: string): Promise<void>
}

export interface SourceQueueWorkerDependencies {
  parsers: Record<SourceType, SourceParser>
  importParsedSourceEvents: typeof importParsedSourceEvents
  extractWithLlm: typeof extractWithLlm
  notifyFailure?: (notice: SourceFailureNotice) => Promise<void>
}

export function shouldReleaseBeforeSourceStart(elapsedMs: number, budgetMs = 105_000): boolean {
  return elapsedMs >= budgetMs
}

export function sourceRetryDelayMinutes(attemptCount: number): 5 | 15 | 60 | null {
  if (attemptCount >= 4) return null
  if (attemptCount === 1) return 5
  if (attemptCount === 2) return 15
  return 60
}

export function shouldFallbackToLlm(
  extractionMode: ExtractionMode,
  deterministicValidCount: number,
  deterministicError: unknown
): boolean {
  return (
    extractionMode === "deterministic_then_llm" &&
    (deterministicValidCount === 0 || deterministicError != null)
  )
}

export function buildExtractionErrorTrace(input: {
  queueId: number
  runId: string
  sourceId: string
  extractionMode: ExtractionMode
  extractor: "deterministic" | "llm"
  error: string
}): ExtractionTraceInsert {
  return {
    source_queue_id: input.queueId,
    source_run_id: input.runId,
    source_id: input.sourceId,
    extraction_mode: input.extractionMode,
    extractor: input.extractor,
    status: "error" as const,
    error: input.error,
    parsed_event_count: 0,
  }
}

export function planSourceQueueClaimHandling(
  claimedIds: number[],
  elapsedMs: number
): { start: number | null; release: number[] } {
  if (claimedIds.length === 0) return { start: null, release: [] }
  if (shouldReleaseBeforeSourceStart(elapsedMs)) {
    return { start: null, release: claimedIds }
  }
  const [first, ...rest] = claimedIds
  return { start: first ?? null, release: rest }
}

const defaultWorkerDependencies: SourceQueueWorkerDependencies = {
  parsers,
  importParsedSourceEvents,
  extractWithLlm,
}

// U3 life-support alerting (R14): one ping per failed run, one per new
// dead-letter (attempt 4 is the scheduleRetry dead-letter threshold). The ping
// must never break the pipeline it monitors, so failures here only log.
async function notifySourceFailure(
  dependencies: SourceQueueWorkerDependencies,
  source: EventSourceRow,
  attemptCount: number,
  error: string
): Promise<void> {
  if (!dependencies.notifyFailure) return
  try {
    await dependencies.notifyFailure({
      kind: sourceRetryDelayMinutes(attemptCount) === null ? "dead_letter" : "run_failed",
      sourceName: source.name,
      error,
    })
  } catch (err) {
    logEdgeEvent("warn", "source failure notification threw", {
      function: "process-source-queue",
      source_id: source.id,
      error: errorMessage(err),
    })
  }
}

async function handleExtractionFailure(
  db: SourceQueueDb,
  row: SourceQueueRow,
  runId: string,
  source: EventSourceRow,
  startedRow: SourceQueueRow,
  extractor: "deterministic" | "llm",
  err: unknown,
  dependencies: SourceQueueWorkerDependencies
): Promise<ProcessSourceQueueResult> {
  const message = errorMessage(err)
  await db.insertExtractionTrace(
    buildExtractionErrorTrace({
      queueId: row.id,
      runId,
      sourceId: source.id,
      extractionMode: source.extraction_mode,
      extractor,
      error: message,
    })
  )
  await markRunError(db, runId, message)
  await db.scheduleSourceScrapeRetry(row.id, startedRow.attempt_count, message)
  await notifySourceFailure(dependencies, source, startedRow.attempt_count, message)
  return { outcome: "retry", imported: 0 }
}

async function markRunError(db: SourceQueueDb, runId: string, message: string): Promise<void> {
  await db.markSourceRunError(runId, message.slice(0, 1000))
}

async function createAndLinkSourceRun(
  db: SourceQueueDb,
  queueId: number,
  sourceId: string
): Promise<string> {
  const runId = await db.createSourceRun(sourceId)
  await db.linkSourceRunToQueueRow(queueId, runId)
  return runId
}

type RunnableSourceRun =
  | {
      status: "loaded"
      source: EventSourceRow
      startedRow: SourceQueueRow
      runId: string
    }
  | { status: "skipped"; result: ProcessSourceQueueResult }

type SourceExtractionResult =
  | { status: "extracted"; parsedEvents: ParsedEvent[] }
  | { status: "retry"; result: ProcessSourceQueueResult }

interface DeterministicExtractionPhase {
  events: ParsedEvent[]
  error: unknown
  shouldUseLlm: boolean
  fallbackReason: string | null
}

async function loadRunnableSourceAndRun(
  db: SourceQueueDb,
  row: SourceQueueRow
): Promise<RunnableSourceRun> {
  if (!row.source_id) {
    await db.markSourceScrapeQueueSkipped(row.id, "source missing from queue row")
    return { status: "skipped", result: { outcome: "skipped", imported: 0 } }
  }

  const source = await db.getEventSource(row.source_id)
  if (!source) {
    await db.markSourceScrapeQueueSkipped(row.id, "source deleted before processing")
    return { status: "skipped", result: { outcome: "skipped", imported: 0 } }
  }
  if (!source.is_active) {
    await db.markSourceScrapeQueueSkipped(row.id, "source disabled before processing")
    return { status: "skipped", result: { outcome: "skipped", imported: 0 } }
  }

  const startedRow = await db.markSourceScrapeQueueStarted(row.id)
  const runId = await createAndLinkSourceRun(db, row.id, source.id)
  return { status: "loaded", source, startedRow, runId }
}

async function runDeterministicExtractionPhase(
  db: SourceQueueDb,
  row: SourceQueueRow,
  source: EventSourceRow,
  runId: string,
  parser: SourceParser,
  artifact: FetchedArtifact,
  ctx: ReturnType<typeof buildParserContext>
): Promise<DeterministicExtractionPhase> {
  if (source.extraction_mode === "llm") {
    return {
      events: [],
      error: null,
      shouldUseLlm: true,
      fallbackReason: null,
    }
  }

  try {
    const events = validateParsedEvents(await parser.extractEvents(source, artifact, ctx))
    const fallbackReason = events.length === 0 ? "deterministic extractor returned no events" : null
    await db.insertExtractionTrace({
      source_queue_id: row.id,
      source_run_id: runId,
      source_id: source.id,
      extraction_mode: source.extraction_mode,
      extractor: "deterministic",
      status: events.length > 0 ? "success" : "fallback",
      input_bytes: artifact.body.length,
      parsed_event_count: events.length,
      fallback_reason: fallbackReason,
    })
    return {
      events,
      error: null,
      shouldUseLlm: shouldFallbackToLlm(source.extraction_mode, events.length, null),
      fallbackReason,
    }
  } catch (err) {
    const message = errorMessage(err)
    await db.insertExtractionTrace(
      buildExtractionErrorTrace({
        queueId: row.id,
        runId,
        sourceId: source.id,
        extractionMode: source.extraction_mode,
        extractor: "deterministic",
        error: message,
      })
    )
    return {
      events: [],
      error: err,
      shouldUseLlm: shouldFallbackToLlm(source.extraction_mode, 0, err),
      fallbackReason: message,
    }
  }
}

async function extractParsedEventsForSource(
  db: SourceQueueDb,
  row: SourceQueueRow,
  source: EventSourceRow,
  startedRow: SourceQueueRow,
  runId: string,
  dependencies: SourceQueueWorkerDependencies
): Promise<SourceExtractionResult> {
  const parser = dependencies.parsers[source.source_type]
  if (!parser) {
    const result = await handleExtractionFailure(
      db,
      row,
      runId,
      source,
      startedRow,
      "deterministic",
      new Error(`No parser registered for source_type=${source.source_type}`),
      dependencies
    )
    return { status: "retry", result }
  }

  const ctx = buildParserContext(
    source.city_id ? await resolveTimezone(db, source) : "America/Chicago"
  )
  let artifact: FetchedArtifact
  try {
    artifact = await parser.fetchArtifact(source, ctx)
  } catch (err) {
    const result = await handleExtractionFailure(
      db,
      row,
      runId,
      source,
      startedRow,
      "deterministic",
      err,
      dependencies
    )
    return { status: "retry", result }
  }

  const deterministic = await runDeterministicExtractionPhase(
    db,
    row,
    source,
    runId,
    parser,
    artifact,
    ctx
  )

  if (source.extraction_mode === "deterministic" && deterministic.error) {
    const message =
      deterministic.error instanceof Error
        ? deterministic.error.message
        : "Deterministic extraction returned no valid events"
    await markRunError(db, runId, message)
    await db.scheduleSourceScrapeRetry(row.id, startedRow.attempt_count, message)
    await notifySourceFailure(dependencies, source, startedRow.attempt_count, message)
    return {
      status: "retry",
      result: { outcome: "retry", imported: 0 },
    }
  }

  if (source.extraction_mode !== "llm" && deterministic.shouldUseLlm) {
    logEdgeEvent("warn", "deterministic extraction falling back to llm", {
      function: "process-source-queue",
      source_id: source.id,
      queue_row_id: row.id,
      deterministic_error:
        deterministic.error instanceof Error ? deterministic.error.message : null,
    })
  }

  let parsedEvents = deterministic.events
  if (deterministic.shouldUseLlm) {
    try {
      const llm = await dependencies.extractWithLlm(source, artifact)
      const valid = validateParsedEvents(llm.events)
      if (valid.length !== llm.events.length) {
        throw new Error("LLM returned invalid ParsedEvent rows")
      }
      await db.insertExtractionTrace({
        source_queue_id: row.id,
        source_run_id: runId,
        source_id: source.id,
        extraction_mode: source.extraction_mode,
        extractor: "llm",
        provider: llm.config.provider,
        model: llm.config.model,
        status: "success",
        input_bytes: artifact.body.length,
        parsed_event_count: valid.length,
        fallback_reason: deterministic.fallbackReason,
        latency_ms: llm.latencyMs,
        reasoning_summary: `LLM extraction completed in ${llm.latencyMs}ms`,
      })
      parsedEvents = valid
    } catch (err) {
      const result = await handleExtractionFailure(
        db,
        row,
        runId,
        source,
        startedRow,
        "llm",
        err,
        dependencies
      )
      return { status: "retry", result }
    }
  }

  return { status: "extracted", parsedEvents }
}

export async function processSourceQueueRow(
  db: SourceQueueDb,
  row: SourceQueueRow,
  dependencies: SourceQueueWorkerDependencies = defaultWorkerDependencies
): Promise<ProcessSourceQueueResult> {
  const runnable = await loadRunnableSourceAndRun(db, row)
  if (runnable.status === "skipped") {
    return runnable.result
  }

  const extraction = await extractParsedEventsForSource(
    db,
    row,
    runnable.source,
    runnable.startedRow,
    runnable.runId,
    dependencies
  )
  if (extraction.status === "retry") {
    return extraction.result
  }

  const result = await dependencies.importParsedSourceEvents(
    db,
    runnable.source,
    runnable.runId,
    extraction.parsedEvents
  )

  if (result.status !== "success" && result.status !== "partial") {
    const message = result.error ?? "Source processing failed"
    await db.scheduleSourceScrapeRetry(row.id, runnable.startedRow.attempt_count, message)
    await notifySourceFailure(
      dependencies,
      runnable.source,
      runnable.startedRow.attempt_count,
      message
    )
    return { outcome: "retry", imported: result.eventsImported }
  }

  await db.markSourceScrapeQueueSucceeded(row.id)

  return { outcome: "succeeded", imported: result.eventsImported }
}

/**
 * One worker invocation: reap stuck rows, claim 1 (SKIP LOCKED), release the
 * claim when over the time budget, process the row. Ported from the legacy
 * process-source-queue index.ts.
 */
export async function processSourceQueueBatch(
  db: SourceQueueDb,
  dependencies: SourceQueueWorkerDependencies = defaultWorkerDependencies
): Promise<{
  claimed: number
  started: number
  released: number
  reaped: number
  outcome: string | null
}> {
  const workerStartedAt = Date.now()
  const reaped = await db.reapStuckSourceScrapeQueueRows()

  const rows = await db.claimSourceScrapeQueueBatch(sourceClaimLimit())
  const plan = planSourceQueueClaimHandling(
    rows.map((row) => row.id),
    Date.now() - workerStartedAt
  )

  if (plan.release.length > 0) {
    await db.releaseUnstartedSourceScrapeQueueRows(plan.release)
  }

  if (plan.start == null) {
    return {
      claimed: rows.length,
      started: 0,
      released: plan.release.length,
      reaped,
      outcome: null,
    }
  }

  const row = rows.find((item) => item.id === plan.start)
  if (!row) {
    return {
      claimed: rows.length,
      started: 0,
      released: plan.release.length,
      reaped,
      outcome: null,
    }
  }

  const result = await processSourceQueueRow(db, row, dependencies)
  return {
    claimed: rows.length,
    started: 1,
    released: plan.release.length,
    reaped,
    outcome: result.outcome,
  }
}

function sourceClaimLimit(): number {
  return 1
}

async function resolveTimezone(db: SourceQueueDb, source: EventSourceRow): Promise<string> {
  if (!source.city_id) return "America/Chicago"
  const timezone = await db.fetchCityTimezone(source.city_id)
  return typeof timezone === "string" && timezone ? timezone : "America/Chicago"
}
