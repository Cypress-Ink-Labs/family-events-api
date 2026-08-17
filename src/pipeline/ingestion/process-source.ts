// Import path for parsed source events: cross-source dedup pre-pass, bulk
// import RPC, run finalization, stale escalation, tag-queue kick. Ported from
// family-events-backend supabase/functions/scrape-source/lib/process-source.ts
// (U28). Deviations:
// - The SupabaseClient parameter became the narrow ProcessSourceDb seam
//   (implemented by IngestionRepository over pg). supabase-js surfaces DB
//   errors in the response object; pg throws — so every `const { error } =`
//   check became try/catch with identical handling, including the SQLSTATE
//   42883/42P01 (RPC missing) special cases.
// - Progress flushes ignore errors explicitly (upstream ignored the response
//   error object implicitly).
// - resolveCityTimezone/fetchCityCentroid live on the seam instead of taking a
//   client argument.

import { captureEdgeException } from "../sentry.js"
import { errorContext, errorMessage as formatError, logEdgeEvent } from "../logger.js"
import { guardedFetch } from "./guarded-fetch.js"
import {
  JACCARD_THRESHOLD,
  eventFingerprint,
  isCrossSourceDuplicate,
  jaccardFromTokens,
  titleTokens,
} from "../dedup.js"
import type { ParserContext } from "./parser-context.js"
// tag-fanout retired in Phase 4 — replaced by event_tag_queue + cron worker.
// scrape-source now just enqueues, returning immediately.
import type { EventSourceRow, ParsedEvent, RunStatus, SourceResult } from "./types.js"
export { sanitizeImagesForIngest } from "./enrichment.js"

const SOURCE_FETCH_TIMEOUT_MS = 10_000
const SOURCE_MAX_BYTES = 5 * 1024 * 1024 // 5 MB cap on feed body to prevent OOM
// How many consecutive zero-result scrapes before we mark the source stale.
const STALE_THRESHOLD = 3

const OUTDOOR_TAG_HINTS = ["park", "outdoor", "hike", "nature", "trail", "playground"]
const INDOOR_TAG_HINTS = ["museum", "indoor", "library", "theater", "theatre"]
const MAX_RAW_IMAGE_CANDIDATES = 20

export interface SourceRunProgress {
  events_found: number
  events_imported: number
  events_skipped: number
}

export interface SourceRunFinalization extends SourceRunProgress {
  completed_at: string
  status: RunStatus
  error_log: string | null
}

export interface EventSourceRunUpdate {
  last_scraped_at: string
  last_status: RunStatus | "pending"
  error_count: number
  consecutive_zero_result_scrapes: number
  stale_escalated_at?: string
}

export interface AdminAuditLogInsert {
  action: string
  target_type: string
  target_id: string
  admin_user_id: null
  metadata: Record<string, unknown>
}

export interface CrossSourceCandidateRow {
  id: string
  title: string
  source_id: string
  /** UTC ISO 8601 — fingerprint matching slices the raw string at minute precision. */
  start_datetime: string
}

export interface BulkImportResult {
  imported?: number
  updated?: number
  skipped?: number
  enqueued?: number
}

/**
 * The DB operations the import path needs. Mirrors the supabase queries/RPCs
 * the upstream function issued; implemented by IngestionRepository.
 */
export interface ProcessSourceDb {
  /** cities.timezone lookup; "UTC" when the city is unknown (upstream schedule.ts). */
  resolveCityTimezone(cityId: string | null): Promise<string>
  fetchCityCentroid(
    cityId: string | null
  ): Promise<{ latitude: number | null; longitude: number | null } | null>
  /** Live progress flush to source_runs — best-effort. */
  updateSourceRunProgress(runId: string, progress: SourceRunProgress): Promise<void>
  /** find_cross_source_event_candidates RPC. Throws pg errors (code = SQLSTATE). */
  findCrossSourceEventCandidates(args: {
    cityId: string
    startFrom: string
    startTo: string
    limit: number
  }): Promise<CrossSourceCandidateRow[]>
  /** bulk_import_scrape_events RPC. Throws pg errors (code = SQLSTATE). */
  bulkImportScrapeEvents(
    runId: string,
    sourceId: string,
    events: Record<string, unknown>[]
  ): Promise<BulkImportResult | null>
  finalizeSourceRun(runId: string, finalization: SourceRunFinalization): Promise<void>
  updateEventSourceAfterRun(sourceId: string, update: EventSourceRunUpdate): Promise<void>
  insertAdminAuditLog(row: AdminAuditLogInsert): Promise<void>
  /** invoke_process_tag_queue RPC (async net.http_post fan-out on the DB side). */
  invokeProcessTagQueue(): Promise<void>
}

export function deriveIsOutdoorFromParsedEvent(parsed: ParsedEvent): boolean | null {
  const text = [parsed.title, parsed.description, parsed.venueName, parsed.address]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase()

  const hasOutdoorSignal = OUTDOOR_TAG_HINTS.some((keyword) => text.includes(keyword))
  const hasIndoorSignal = INDOOR_TAG_HINTS.some((keyword) => text.includes(keyword))

  if (hasOutdoorSignal && !hasIndoorSignal) {
    return true
  }
  if (hasIndoorSignal && !hasOutdoorSignal) {
    return false
  }
  return null
}

export function deriveRawImageCandidates(parsed: ParsedEvent): string[] {
  const seen = new Set<string>()
  const candidates = [...parsed.images, ...(parsed.imageUrl ? [parsed.imageUrl] : [])]

  for (const candidate of candidates) {
    const url = candidate.trim()
    if (!url.startsWith("http://") && !url.startsWith("https://")) continue
    if (seen.has(url)) continue
    seen.add(url)
    if (seen.size >= MAX_RAW_IMAGE_CANDIDATES) break
  }

  return [...seen]
}

async function readResponseBodyCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  const readNextChunk = async (): Promise<void> => {
    const { done, value } = await reader.read()
    if (done) return

    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error(`Response body exceeded cap of ${maxBytes} bytes`)
    }

    chunks.push(value)
    await readNextChunk()
  }

  try {
    await readNextChunk()
  } finally {
    reader.releaseLock()
  }

  const buf = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    buf.set(c, offset)
    offset += c.byteLength
  }
  return new TextDecoder("utf-8").decode(buf)
}

const DEFAULT_FETCH_ACCEPT = "text/html,application/xml,text/xml,*/*"

async function guardedFetchText(url: string, accept: string): Promise<string> {
  // SSRF-safe fetch. guardedFetch resolves + range-checks the URL AND every
  // redirect hop, and never transparently follows a redirect into an
  // unvalidated target (e.g. 169.254.169.254 metadata, RFC1918, 127.0.0.1).
  const response = await guardedFetch(url, {
    headers: {
      "User-Agent": "family-events-ingester/1.0 (+https://family-events.local)",
      Accept: accept,
    },
    signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS),
  })

  if (!response.ok) {
    throw new Error(`Failed to fetch source (${response.status})`)
  }

  // Streamed read with 5 MB cap. response.text() is unbounded; a malicious or
  // accidentally-huge feed could OOM the worker.
  return await readResponseBodyCapped(response, SOURCE_MAX_BYTES)
}

export function buildParserContext(timezone: string): ParserContext {
  return {
    timezone,
    fetchText: (url, opts) => guardedFetchText(url, opts?.accept ?? DEFAULT_FETCH_ACCEPT),
    fetchJson: async <T = unknown>(url: string, opts?: { accept?: string }): Promise<T> => {
      const body = await guardedFetchText(url, opts?.accept ?? "application/json,*/*")
      return JSON.parse(body) as T
    },
  }
}

// ── Import-path helpers ──────────────────────────────────────────────────
// importParsedSourceEvents was ported as one 400-line function; it is
// decomposed below (PR #16 review) into the same sequential stages the
// upstream comments already described. Semantics are pinned by the unit and
// integration suites.

interface EventPayloadContext {
  source: EventSourceRow
  timezone: string
  cityCentroid: { latitude: number | null; longitude: number | null } | null
}

function prepEventPayload(parsed: ParsedEvent, ctx: EventPayloadContext): Record<string, unknown> {
  const isOutdoor = deriveIsOutdoorFromParsedEvent(parsed)
  const imageCandidates = deriveRawImageCandidates(parsed)

  return {
    title: parsed.title,
    description: parsed.description ?? null,
    start_datetime: parsed.startDatetime,
    end_datetime: parsed.endDatetime ?? null,
    timezone: ctx.timezone,
    venue_name: parsed.venueName ?? null,
    address: parsed.address ?? null,
    city_id: ctx.source.city_id,
    source_url: parsed.sourceUrl ?? null,
    source_name: ctx.source.name,
    images: imageCandidates,
    price: parsed.price ?? null,
    is_free: Boolean(parsed.isFree),
    is_outdoor: isOutdoor,
    latitude: ctx.cityCentroid?.latitude ?? null,
    longitude: ctx.cityCentroid?.longitude ?? null,
  }
}

// Observability: warn when >50% of a batch has no address data — possible
// parser regression.
function warnOnHighAddressNullRate(
  source: EventSourceRow,
  eventsFound: number,
  addressNullCount: number
): void {
  const addressNullRate = eventsFound > 0 ? addressNullCount / eventsFound : 0
  if (eventsFound > 0 && addressNullRate > 0.5) {
    logEdgeEvent("warn", "high address null rate — possible parser regression", {
      function: "process-source",
      source_id: source.id,
      source_name: source.name,
      source_type: source.source_type,
      events_found: eventsFound,
      address_null: addressNullCount,
      address_null_pct: Math.round(addressNullRate * 100),
    })
  }
}

type PreparedCandidate = CrossSourceCandidateRow & {
  fp: string
  tokens: Set<string>
  hourBucket: number | null
}

/** ±4h window around the batch's start_datetime range, or null if none parse. */
function dedupWindow(payloads: Record<string, unknown>[]): { from: string; to: string } | null {
  const startTimes = payloads
    .map((p) => new Date(p.start_datetime as string).getTime())
    .filter((t) => !Number.isNaN(t))
  if (startTimes.length === 0) return null
  const FOUR_HOURS_MS = 4 * 60 * 60 * 1000
  return {
    from: new Date(Math.min(...startTimes) - FOUR_HOURS_MS).toISOString(),
    to: new Date(Math.max(...startTimes) + FOUR_HOURS_MS).toISOString(),
  }
}

/** Candidate fetch with the RPC-missing / transient-failure downgrade to "no dedup". */
async function fetchDedupCandidates(
  db: ProcessSourceDb,
  source: EventSourceRow,
  cityId: string,
  window: { from: string; to: string }
): Promise<CrossSourceCandidateRow[] | null> {
  try {
    return await db.findCrossSourceEventCandidates({
      cityId,
      startFrom: window.from,
      startTo: window.to,
      limit: 1000,
    })
  } catch (candidateError) {
    const code = (candidateError as { code?: string }).code
    if (code === "42883" || code === "42P01") {
      // RPC not yet deployed — skip dedup gracefully and import all events.
      // This is non-fatal: ingestion must continue even pre-migration.
      logEdgeEvent("warn", "find_cross_source_event_candidates RPC missing — skipping dedup", {
        function: "process-source",
        source_id: source.id,
        hint: "Run `supabase db push --linked` to apply migration 20260620010000.",
      })
    } else {
      // Non-fatal: log and continue without dedup so ingestion is not blocked.
      logEdgeEvent("warn", "cross-source dedup candidate fetch failed — skipping dedup", {
        function: "process-source",
        source_id: source.id,
        error: formatError(candidateError),
      })
    }
    return null
  }
}

function prepareCandidateMaps(
  rows: CrossSourceCandidateRow[],
  source: EventSourceRow
): { exactMap: Map<string, PreparedCandidate>; bucketMap: Map<number, PreparedCandidate[]> } {
  const exactMap = new Map<string, PreparedCandidate>()
  const bucketMap = new Map<number, PreparedCandidate[]>()
  for (const candidate of rows) {
    // Same-source dedup is handled by bulk_import_scrape_events.
    if (candidate.source_id === source.id) continue

    const startMs = new Date(candidate.start_datetime).getTime()
    const prepared: PreparedCandidate = {
      ...candidate,
      fp: eventFingerprint(candidate.title, candidate.start_datetime, source.city_id),
      tokens: titleTokens(candidate.title),
      hourBucket: Number.isFinite(startMs) ? Math.floor(startMs / 3_600_000) : null,
    }
    exactMap.set(prepared.fp, prepared)
    if (prepared.hourBucket !== null) {
      const bucket = bucketMap.get(prepared.hourBucket)
      if (bucket) {
        bucket.push(prepared)
      } else {
        bucketMap.set(prepared.hourBucket, [prepared])
      }
    }
  }
  return { exactMap, bucketMap }
}

/** Exact fingerprint match, then the Jaccard ≥ threshold scan over ±4 hour buckets. */
function findCrossSourceMatch(
  payload: Record<string, unknown>,
  source: EventSourceRow,
  exactMap: Map<string, PreparedCandidate>,
  bucketMap: Map<number, PreparedCandidate[]>
): PreparedCandidate | undefined {
  const title = payload.title as string
  const startDatetime = payload.start_datetime as string
  let match = exactMap.get(eventFingerprint(title, startDatetime, source.city_id))
  if (match) return match

  const startMs = new Date(startDatetime).getTime()
  if (!Number.isFinite(startMs)) return undefined

  const tokens = titleTokens(title)
  const hourBucket = Math.floor(startMs / 3_600_000)
  for (let bucket = hourBucket - 4; bucket <= hourBucket + 4 && !match; bucket += 1) {
    const candidatesInBucket = bucketMap.get(bucket)
    if (!candidatesInBucket) continue

    for (const candidate of candidatesInBucket) {
      if (
        jaccardFromTokens(tokens, candidate.tokens) >= JACCARD_THRESHOLD &&
        isCrossSourceDuplicate(
          title,
          startDatetime,
          candidate.title,
          candidate.start_datetime,
          source.city_id
        )
      ) {
        match = candidate
        break
      }
    }
  }
  return match
}

// ── Cross-source fuzzy dedup pre-pass (CIL-16) ──────────────────────────────
// Only runs when city_id is known — without a city scope the query cannot be
// bounded, so we skip dedup and import everything.
async function applyCrossSourceDedup(
  db: ProcessSourceDb,
  source: EventSourceRow,
  runId: string,
  payloads: Record<string, unknown>[]
): Promise<{ payloads: Record<string, unknown>[]; skipped: number }> {
  const cityId = source.city_id
  if (!cityId || payloads.length === 0) return { payloads, skipped: 0 }

  const window = dedupWindow(payloads)
  if (!window) return { payloads, skipped: 0 }

  const candidates = await fetchDedupCandidates(db, source, cityId, window)
  if (!candidates) return { payloads, skipped: 0 }

  if (candidates.length === 1000) {
    logEdgeEvent(
      "warn",
      "cross-source dedup candidate cap reached — duplicates beyond cap may be missed",
      {
        function: "process-source",
        source_id: source.id,
        candidate_count: candidates.length,
      }
    )
  }

  const { exactMap, bucketMap } = prepareCandidateMaps(candidates, source)

  let skipped = 0
  const deduped = payloads.filter((payload) => {
    const match = findCrossSourceMatch(payload, source, exactMap, bucketMap)
    if (match) {
      skipped += 1
      logEdgeEvent("log", "skipped cross-source duplicate", {
        function: "process-source",
        source_id: source.id,
        run_id: runId,
        candidate_title: payload.title,
        candidate_start: payload.start_datetime,
        matched_event_id: match.id,
        matched_source_id: match.source_id,
      })
      return false
    }
    return true
  })
  return { payloads: deduped, skipped }
}

// Single bulk RPC: classify + INSERT + UPDATE + event_tag_queue enqueue all in
// one SQL transaction. Replaces the prior per-event loop (which blew the 150s
// edge function wall at ~145/605 events). Throws on unexpected DB errors;
// returns setupError when the RPC is missing (migration not applied yet).
async function runBulkImport(
  db: ProcessSourceDb,
  source: EventSourceRow,
  runId: string,
  payloads: Record<string, unknown>[]
): Promise<{ imported: number; skipped: number; setupError: string | null }> {
  let bulkResult: BulkImportResult | null = null
  try {
    bulkResult = await db.bulkImportScrapeEvents(runId, source.id, payloads)
  } catch (bulkError) {
    const code = (bulkError as { code?: string }).code
    if (code === "42883" || code === "42P01") {
      // RPC missing -> grouped event ingestion migration not applied yet.
      return {
        imported: 0,
        skipped: 0,
        setupError:
          "bulk_import_scrape_events RPC missing. Run `supabase db push --linked` to apply migration 20260601002000.",
      }
    }
    throw bulkError
  }

  const imported = bulkResult?.imported ?? 0
  const updated = bulkResult?.updated ?? 0
  const skipped = bulkResult?.skipped ?? 0
  const enqueued = bulkResult?.enqueued ?? 0
  // The RPC enqueues into event_tag_queue under ON CONFLICT DO NOTHING.
  // If imported+updated > enqueued, some rows were already pending in
  // the queue from a prior run — benign, not an error.
  if (imported + updated > 0 && enqueued < imported + updated) {
    logEdgeEvent("log", "tag-queue enqueue partial (existing rows)", {
      function: "scrape-source",
      run_id: runId,
      imported,
      updated,
      enqueued,
    })
  }
  return { imported: imported + updated, skipped, setupError: null }
}

interface ImportRunOutcome {
  status: RunStatus
  errorMessage: string | null
  eventsFound: number
  eventsImported: number
  eventsSkipped: number
}

// Final source_runs + event_sources writes. A finalization failure after a
// successful/partial scrape makes the run retryable (source_runs first when
// both fail); it never overwrites an original scrape failure.
async function writeFinalRecords(
  db: ProcessSourceDb,
  source: EventSourceRow,
  runId: string,
  outcome: ImportRunOutcome,
  escalation: { isNewEscalation: boolean; nextConsecutiveZero: number; escalatedAt?: string }
): Promise<{ status: RunStatus; errorMessage: string | null }> {
  const statusBeforeFinalization = outcome.status
  let { status, errorMessage } = outcome
  let finalizationFailureMessage: string | null = null

  let runUpdateError: unknown = null
  try {
    await db.finalizeSourceRun(runId, {
      completed_at: new Date().toISOString(),
      status: statusBeforeFinalization,
      events_found: outcome.eventsFound,
      events_imported: outcome.eventsImported,
      events_skipped: outcome.eventsSkipped,
      error_log: errorMessage,
    })
  } catch (error) {
    runUpdateError = error
  }

  const escalatedStatus = escalation.isNewEscalation ? "stale" : statusBeforeFinalization
  let sourceUpdateError: unknown = null
  try {
    await db.updateEventSourceAfterRun(source.id, {
      last_scraped_at: new Date().toISOString(),
      last_status: escalatedStatus,
      // Only reset error_count on full success. A 'partial' run (events
      // found, none imported) used to clear the counter and mask persistent
      // failures; keep accumulating until a clean success.
      error_count:
        statusBeforeFinalization === "success"
          ? 0
          : source.error_count + (statusBeforeFinalization === "error" ? 1 : 0),
      consecutive_zero_result_scrapes: escalation.nextConsecutiveZero,
      ...(escalation.escalatedAt != null ? { stale_escalated_at: escalation.escalatedAt } : {}),
    })
  } catch (error) {
    sourceUpdateError = error
  }

  for (const [writeName, writeError] of [
    ["source_runs", runUpdateError],
    ["event_sources", sourceUpdateError],
  ] as const) {
    if (!writeError) continue

    if (
      finalizationFailureMessage === null &&
      (statusBeforeFinalization === "success" || statusBeforeFinalization === "partial")
    ) {
      finalizationFailureMessage = `Failed to finalize ${writeName} write: ${formatError(writeError)}`
      status = "error"
      errorMessage = finalizationFailureMessage
    }

    const context = errorContext(writeError, {
      function: "process-source",
      source_id: source.id,
      source_name: source.name,
      run_id: runId,
      stage: "finalize",
      write: writeName,
    })
    logEdgeEvent("error", `failed to finalize ${writeName} write`, context)
    await captureEdgeException(writeError, context)
  }

  return { status, errorMessage }
}

async function recordStaleEscalation(
  db: ProcessSourceDb,
  source: EventSourceRow,
  nextConsecutiveZero: number
): Promise<void> {
  logEdgeEvent("warn", "source escalated to stale", {
    function: "process-source",
    source_id: source.id,
    source_name: source.name,
    consecutive_zero_result_scrapes: nextConsecutiveZero,
    last_scraped_at: source.last_scraped_at,
  })
  try {
    // A failed audit write must never break scrape finalization —
    // whether the DB rejects it (RLS, constraints) or the call throws.
    await db.insertAdminAuditLog({
      action: "source.stale_escalated",
      target_type: "event_source",
      target_id: source.id,
      admin_user_id: null,
      metadata: {
        consecutive_zero_result_scrapes: nextConsecutiveZero,
        last_scraped_at: source.last_scraped_at,
      },
    })
  } catch (auditError) {
    logEdgeEvent("warn", "failed to write stale-escalation audit log", {
      function: "process-source",
      source_id: source.id,
      error: formatError(auditError),
    })
  }
}

// Kick the tag-queue worker if we imported anything. Each RPC call fires
// net.http_post (async) and returns immediately, so this is a fan-out, not a
// blocking loop. process-tag-queue claims BATCH_SIZE=20 events per invocation
// via SKIP LOCKED, so N kicks = up to N×20 events drained in parallel —
// without waiting for the 1-min cron tick.
//
// Cap matches process-tag-queue CONCURRENCY×2 to leave headroom for the
// OpenAI rate limit (the LLM is the actual bottleneck). The cron */1 keeps
// backfilling whatever a burst leaves behind.
async function kickTagQueue(
  db: ProcessSourceDb,
  source: EventSourceRow,
  runId: string,
  eventsImported: number
): Promise<void> {
  if (eventsImported <= 0) return
  const TAG_QUEUE_BATCH_SIZE = 20
  const MAX_KICKS = 8
  const kicks = Math.min(Math.max(1, Math.ceil(eventsImported / TAG_QUEUE_BATCH_SIZE)), MAX_KICKS)
  const results = await Promise.allSettled(
    Array.from({ length: kicks }, () => db.invokeProcessTagQueue())
  )
  const failed = results.filter((r) => r.status === "rejected").length
  if (failed > 0) {
    logEdgeEvent("warn", "tag-queue kick(s) failed after source processing", {
      function: "process-source",
      source_id: source.id,
      run_id: runId,
      events_imported: eventsImported,
      kicks_attempted: kicks,
      kicks_failed: failed,
    })
  }
}

// Finalization MUST run even when the import phase throws unexpectedly.
// Otherwise source_runs is left in 'running' state forever. Its own failures
// are captured, never rethrown.
async function finalizeImportRun(
  db: ProcessSourceDb,
  source: EventSourceRow,
  runId: string,
  outcome: ImportRunOutcome
): Promise<{ status: RunStatus; errorMessage: string | null }> {
  try {
    // Stale-escalation: track consecutive zero-result successes.
    const isZeroResult = outcome.status === "success" && outcome.eventsFound === 0
    const nextConsecutiveZero = isZeroResult ? (source.consecutive_zero_result_scrapes ?? 0) + 1 : 0
    const isNewEscalation =
      nextConsecutiveZero >= STALE_THRESHOLD && source.stale_escalated_at == null
    const escalatedAt = isNewEscalation ? new Date().toISOString() : undefined

    const finalized = await writeFinalRecords(db, source, runId, outcome, {
      isNewEscalation,
      nextConsecutiveZero,
      ...(escalatedAt != null ? { escalatedAt } : {}),
    })

    if (isNewEscalation) {
      await recordStaleEscalation(db, source, nextConsecutiveZero)
    }
    await kickTagQueue(db, source, runId, outcome.eventsImported)
    return finalized
  } catch (finalizeError) {
    await captureEdgeException(
      finalizeError,
      errorContext(finalizeError, {
        function: "scrape-source",
        source_id: source.id,
        source_name: source.name,
        run_id: runId,
        stage: "finalize",
      })
    )
    return { status: outcome.status, errorMessage: outcome.errorMessage }
  }
}

export async function importParsedSourceEvents(
  db: ProcessSourceDb,
  source: EventSourceRow,
  runId: string,
  parsedEvents: ParsedEvent[]
): Promise<SourceResult> {
  let status: RunStatus = "success"
  let eventsFound = 0
  let eventsImported = 0
  let eventsSkipped = 0
  let addressNullCount = 0
  let errorMessage: string | null = null
  // Fatal pipeline-deploy errors (bulk RPC missing) short-circuit the run
  // because no further work can succeed. Non-fatal enqueue failures are
  // logged but don't propagate — the SQL bulk RPC handles them via
  // ON CONFLICT DO NOTHING and returns a count we cross-check in runBulkImport.
  let pipelineSetupError: string | null = null

  // Flush live progress to source_runs so the UI can show incremental counts.
  async function flushProgress() {
    try {
      await db.updateSourceRunProgress(runId, {
        events_found: eventsFound,
        events_imported: eventsImported,
        events_skipped: eventsSkipped,
      })
    } catch {
      // Best-effort: upstream ignored the progress-flush response error too.
    }
  }

  try {
    const [timezone, cityCentroid] = await Promise.all([
      db.resolveCityTimezone(source.city_id),
      db.fetchCityCentroid(source.city_id),
    ])
    eventsFound = parsedEvents.length

    // Observability: count events missing geocodable location data
    addressNullCount = parsedEvents.filter((e) => e.address === null && e.venueName === null).length
    warnOnHighAddressNullRate(source, eventsFound, addressNullCount)

    // Write total found immediately so the UI shows "X found" while import runs.
    await flushProgress()

    const validEvents = parsedEvents.filter((p) => {
      if (!p.title || !p.startDatetime) {
        eventsSkipped += 1
        return false
      }
      return true
    })

    if (validEvents.length === 0) {
      await flushProgress()
    } else {
      const payloadContext: EventPayloadContext = { source, timezone, cityCentroid }
      const payloads = validEvents.map((parsed) => prepEventPayload(parsed, payloadContext))

      const dedup = await applyCrossSourceDedup(db, source, runId, payloads)
      // Report cross-source skips alongside the RPC's own skipped count.
      eventsSkipped += dedup.skipped

      const bulk = await runBulkImport(db, source, runId, dedup.payloads)
      pipelineSetupError = bulk.setupError
      if (pipelineSetupError === null) {
        eventsImported = bulk.imported
        eventsSkipped += bulk.skipped
      }

      await flushProgress()
    }

    // Observability: log final run summary on success path
    logEdgeEvent("log", "process-source run complete", {
      function: "process-source",
      source_id: source.id,
      source_name: source.name,
      source_type: source.source_type,
      run_id: runId,
      events_found: eventsFound,
      events_imported: eventsImported,
      events_skipped: eventsSkipped,
      address_null: addressNullCount,
    })

    // Status derivation precedence:
    //   1. pipelineSetupError (bulk RPC missing) → 'error' + actionable hint
    //   2. found events but imported none → 'partial'
    //   3. otherwise 'success' (default initial value)
    if (pipelineSetupError) {
      status = "error"
      errorMessage = pipelineSetupError
    } else if (eventsImported === 0 && eventsFound > 0) {
      status = "partial"
    }
  } catch (error) {
    status = "error"
    // formatError surfaces the DB error code + details (SQLSTATE lives on the
    // pg DatabaseError instance; plain-object errors don't pass `instanceof
    // Error`, so the original code silently collapsed them to "Unknown scrape
    // failure").
    errorMessage = formatError(error) || "Unknown scrape failure."
    const context = errorContext(error, {
      function: "scrape-source",
      source_id: source.id,
      source_name: source.name,
      source_type: source.source_type,
      run_id: runId,
    })
    await captureEdgeException(error, context)
    logEdgeEvent("error", "scrape-source fetch failed", context)
  } finally {
    const finalized = await finalizeImportRun(db, source, runId, {
      status,
      errorMessage,
      eventsFound,
      eventsImported,
      eventsSkipped,
    })
    status = finalized.status
    errorMessage = finalized.errorMessage
  }

  return {
    sourceId: source.id,
    status,
    eventsFound,
    eventsImported,
    eventsSkipped,
    error: errorMessage,
  }
}
