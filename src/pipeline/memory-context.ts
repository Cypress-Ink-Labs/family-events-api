// Memory context retrieval for the adaptive review/tagging pipeline: fetches
// similar events and their tags/admin corrections/review outcomes to build
// few-shot context for LLM prompts, plus the memory feature-flag gate used by
// the review-queue worker's "source-auto-reject" check.
// Ported from family-events-backend supabase/functions/_shared/memory-context.ts
// (U29, post plan-036 bulk hydration). Deviations:
// - The SupabaseClient parameter became the narrow MemoryContextDb seam,
//   implemented by the classification repository in a later PR. Each
//   supabase-js query builder chain (`.rpc`, `.from().select().in().order()`,
//   `.maybeSingle()`) became one named seam method with typed inputs/outputs.
// - supabase-js surfaces DB errors via a `{ data, error }` response object;
//   the seam throws instead (pg style, matching ProcessSourceDb). Every
//   `if (error) { ...; return <fallback> }` branch became a try/catch around
//   the seam call with identical logging and fallback behavior. The
//   uncaught-on-purpose `find_similar_events` error (`if (simError) throw
//   simError`) stays uncaught — the seam call is not wrapped in try/catch.
// - `isMemoryFeatureEnabled`'s `{ data, error } = ...maybeSingle()` became
//   `db.getMemoryFeatureFlag`, which returns the row or null (no match) and
//   throws on a real DB error; the outer try/catch still collapses both
//   "no row" and "query failed" to `false`, matching upstream exactly.
// - CodeRabbit U29 review: that catch now logs a warn
//   ("memory-context: failed to read memory feature flag", with feature +
//   errorMessage) — upstream's catch was silent. The return-false fallback is
//   unchanged, matching every other failure path in this module.

import { errorMessage, logEdgeEvent } from "./logger.js"

// ── Types ────────────────────────────────────────────────────────────────────

export interface SimilarEventTag {
  slug: string
  name: string
  source: "ai" | "admin"
  confidence: number
}

export interface SimilarEventTagContext {
  eventId: string
  title: string
  cosineDistance: number
  tags: SimilarEventTag[]
  adminCorrected: boolean
  adminReason: string | null
}

export interface SimilarEventReviewContext {
  eventId: string
  title: string
  cosineDistance: number
  status: string
  llmReviewDecision: string | null
  adminOverridden: boolean
  adminDecision: string | null
  adminReason: string | null
}

export interface ReviewConfidenceAdjustment {
  delta: number
  reason: string
  approvedCount: number
  rejectedCount: number
  totalSimilar: number
}

export type MemoryFeature = "tag-memory" | "review-memory" | "source-auto-reject"

// ── DB seam ──────────────────────────────────────────────────────────────────

export interface SimilarEventRow {
  event_id: string
  title: string
  cosine_distance: number
  source_id: string | null
  city_id: string | null
  status: string
}

export interface EventTagRow {
  event_id: string
  tag_id: string
  confidence: number
  is_manual_override: boolean
  tags: { slug: string; name: string } | null
}

export interface AdminDecisionRow {
  event_id: string
  decision_type: string
  new_tags: unknown
  reason: string | null
  created_at: string
}

export interface ReviewEventRow {
  id: string
  status: string
  llm_review_decision: string | null
}

export interface ReviewAdminDecisionRow {
  event_id: string
  decision_type: string
  new_status: string
  reason: string | null
  created_at: string
}

export interface FindSimilarEventsArgs {
  /** pgvector literal, e.g. "[0.1,0.2,...]" — built from the embedding by the caller. */
  embedding: string
  limit: number
  threshold: number
  excludeEventId: string | null
  cityId: string | null
}

/**
 * The DB operations memory-context needs. Mirrors the supabase-js
 * queries/RPC the upstream module issued; implemented by the classification
 * repository (later PR). Bulk-read methods throw on a genuine DB error (pg
 * style); callers wrap each in try/catch and fall back exactly as upstream did.
 */
export interface MemoryContextDb {
  /** ai_feature_config lookup by feature; null when no row matches (maybeSingle). */
  getMemoryFeatureFlag(feature: MemoryFeature): Promise<{ enabled: boolean } | null>
  /** find_similar_events RPC. Not wrapped by callers — errors propagate. */
  findSimilarEvents(args: FindSimilarEventsArgs): Promise<SimilarEventRow[]>
  /** event_tags bulk read joined to tags(slug, name), filtered by event_id. */
  fetchEventTagsForEvents(eventIds: string[]): Promise<EventTagRow[]>
  /** admin_event_decisions bulk read for tag_edit/status_and_tags, newest first. */
  fetchTagDecisionsForEvents(eventIds: string[]): Promise<AdminDecisionRow[]>
  /** events bulk read (id, status, llm_review_decision) by id. */
  fetchReviewEventsByIds(eventIds: string[]): Promise<ReviewEventRow[]>
  /** admin_event_decisions bulk read for status_change, newest first. */
  fetchStatusDecisionsForEvents(eventIds: string[]): Promise<ReviewAdminDecisionRow[]>
}

// ── Feature flag check ───────────────────────────────────────────────────────

export async function isMemoryFeatureEnabled(
  db: MemoryContextDb,
  feature: MemoryFeature
): Promise<boolean> {
  try {
    const row = await db.getMemoryFeatureFlag(feature)
    if (!row) return false
    return row.enabled === true
  } catch (error) {
    logEdgeEvent("warn", "memory-context: failed to read memory feature flag", {
      feature,
      error: errorMessage(error),
    })
    return false
  }
}

// ── Shared similarity-query constants ───────────────────────────────────────

const SIMILARITY_THRESHOLD = 0.3
const DEFAULT_SIMILAR_LIMIT = 5

function emptyConfidenceAdjustment(): ReviewConfidenceAdjustment {
  return {
    delta: 0,
    reason: "no similar events found",
    approvedCount: 0,
    rejectedCount: 0,
    totalSimilar: 0,
  }
}

// ── Tagging memory context ───────────────────────────────────────────────────

export async function fetchSimilarEventTagContext(
  db: MemoryContextDb,
  embedding: number[],
  excludeEventId: string | null,
  cityId: string | null,
  limit = DEFAULT_SIMILAR_LIMIT
): Promise<SimilarEventTagContext[]> {
  const vectorStr = `[${embedding.join(",")}]`

  const similarRows = await db.findSimilarEvents({
    embedding: vectorStr,
    limit,
    threshold: SIMILARITY_THRESHOLD,
    excludeEventId,
    cityId,
  })
  if (similarRows.length === 0) return []

  const eventIds = [...new Set(similarRows.map((row) => row.event_id))]

  let tagRows: EventTagRow[]
  try {
    tagRows = await db.fetchEventTagsForEvents(eventIds)
  } catch (tagError) {
    logEdgeEvent("warn", "memory-context: failed to bulk fetch tags for similar events", {
      error: errorMessage(tagError),
    })
    return []
  }

  let decisionRows: AdminDecisionRow[]
  try {
    decisionRows = await db.fetchTagDecisionsForEvents(eventIds)
  } catch (decisionError) {
    logEdgeEvent("warn", "memory-context: failed to bulk fetch tag decisions for similar events", {
      error: errorMessage(decisionError),
    })
    return []
  }

  const tagsByEvent = new Map<string, EventTagRow[]>()
  for (const tagRow of tagRows) {
    const tags = tagsByEvent.get(tagRow.event_id) ?? []
    tags.push(tagRow)
    tagsByEvent.set(tagRow.event_id, tags)
  }

  const decisionsByEvent = new Map<string, AdminDecisionRow>()
  for (const decisionRow of decisionRows) {
    if (!decisionsByEvent.has(decisionRow.event_id)) {
      decisionsByEvent.set(decisionRow.event_id, decisionRow)
    }
  }

  return similarRows.map((row) => {
    const tags: SimilarEventTag[] = (tagsByEvent.get(row.event_id) ?? [])
      .filter((tag) => tag.tags)
      .map((tag) => ({
        slug: tag.tags!.slug,
        name: tag.tags!.name,
        source: tag.is_manual_override ? ("admin" as const) : ("ai" as const),
        confidence: tag.confidence,
      }))
      .sort((a, b) => {
        if (a.source !== b.source) return a.source === "admin" ? -1 : 1
        return b.confidence - a.confidence
      })
    const latestDecision = decisionsByEvent.get(row.event_id) ?? null

    return {
      eventId: row.event_id,
      title: row.title.slice(0, 100),
      cosineDistance: row.cosine_distance,
      tags,
      adminCorrected: latestDecision !== null || tags.some((tag) => tag.source === "admin"),
      adminReason: latestDecision?.reason ?? null,
    }
  })
}

// ── Review memory context ────────────────────────────────────────────────────

export async function fetchSimilarReviewContext(
  db: MemoryContextDb,
  embedding: number[],
  excludeEventId: string | null,
  cityId: string | null,
  limit = DEFAULT_SIMILAR_LIMIT
): Promise<{
  contexts: SimilarEventReviewContext[]
  confidenceAdjustment: ReviewConfidenceAdjustment
}> {
  const vectorStr = `[${embedding.join(",")}]`

  const similarRows = await db.findSimilarEvents({
    embedding: vectorStr,
    limit,
    threshold: SIMILARITY_THRESHOLD,
    excludeEventId,
    cityId,
  })

  if (similarRows.length === 0) {
    return { contexts: [], confidenceAdjustment: emptyConfidenceAdjustment() }
  }

  const eventIds = [...new Set(similarRows.map((row) => row.event_id))]

  let eventRows: ReviewEventRow[]
  try {
    eventRows = await db.fetchReviewEventsByIds(eventIds)
  } catch (eventError) {
    logEdgeEvent("warn", "memory-context: failed to bulk fetch review events", {
      error: errorMessage(eventError),
    })
    return { contexts: [], confidenceAdjustment: emptyConfidenceAdjustment() }
  }

  let decisionRows: ReviewAdminDecisionRow[]
  try {
    decisionRows = await db.fetchStatusDecisionsForEvents(eventIds)
  } catch (decisionError) {
    logEdgeEvent("warn", "memory-context: failed to bulk fetch review decisions", {
      error: errorMessage(decisionError),
    })
    return { contexts: [], confidenceAdjustment: emptyConfidenceAdjustment() }
  }

  const eventsById = new Map<string, ReviewEventRow>()
  for (const eventRow of eventRows) {
    eventsById.set(eventRow.id, eventRow)
  }

  const decisionsByEvent = new Map<string, ReviewAdminDecisionRow>()
  for (const decisionRow of decisionRows) {
    if (!decisionsByEvent.has(decisionRow.event_id)) {
      decisionsByEvent.set(decisionRow.event_id, decisionRow)
    }
  }

  const contexts: SimilarEventReviewContext[] = []
  let approvedCount = 0
  let rejectedCount = 0

  for (const row of similarRows) {
    const eventRow = eventsById.get(row.event_id)
    if (!eventRow) continue

    const latestAdminDecision = decisionsByEvent.get(row.event_id) ?? null
    if (eventRow.status === "published") approvedCount++
    if (eventRow.status === "rejected") rejectedCount++

    contexts.push({
      eventId: row.event_id,
      title: row.title.slice(0, 100),
      cosineDistance: row.cosine_distance,
      status: eventRow.status,
      llmReviewDecision: eventRow.llm_review_decision,
      adminOverridden: latestAdminDecision !== null,
      adminDecision: latestAdminDecision?.new_status ?? null,
      adminReason: latestAdminDecision?.reason ?? null,
    })
  }

  const totalSimilar = contexts.length
  let delta = 0
  let reason = "mixed outcomes among similar events"

  if (totalSimilar > 0) {
    const approvedRate = approvedCount / totalSimilar
    const rejectedRate = rejectedCount / totalSimilar

    if (approvedRate >= 0.8) {
      delta = 0.1
      reason = `${approvedCount}/${totalSimilar} similar events were approved`
    } else if (rejectedRate >= 0.8) {
      delta = -0.1
      reason = `${rejectedCount}/${totalSimilar} similar events were rejected`
    }
  }

  return {
    contexts,
    confidenceAdjustment: { delta, reason, approvedCount, rejectedCount, totalSimilar },
  }
}

// ── Prompt formatting helpers ────────────────────────────────────────────────

export function formatTagMemoryPrompt(contexts: SimilarEventTagContext[]): string {
  if (contexts.length === 0) return ""

  const lines = ["", "MEMORY CONTEXT — similar events previously processed:"]

  for (const ctx of contexts) {
    const tagList = ctx.tags
      .map((t) => {
        const suffix = t.source === "admin" ? " (admin-corrected)" : ""
        return `${t.slug}${suffix}`
      })
      .join(", ")

    const correctionNote = ctx.adminCorrected ? " [ADMIN CORRECTED]" : ""
    lines.push(`- "${ctx.title}" → tags: [${tagList}]${correctionNote}`)
    if (ctx.adminReason) {
      lines.push(`  Admin reason: ${ctx.adminReason}`)
    }
  }

  lines.push("")
  lines.push(
    "Use these examples as reference when classifying the current event. Admin-corrected tags are higher-quality signals."
  )

  return lines.join("\n")
}

export function formatReviewMemoryPrompt(contexts: SimilarEventReviewContext[]): string {
  if (contexts.length === 0) return ""

  const lines = ["", "MEMORY CONTEXT — similar events previously reviewed:"]

  for (const ctx of contexts) {
    const overrideNote = ctx.adminOverridden ? " (admin-overridden)" : ""
    lines.push(`- "${ctx.title}" → ${ctx.status}${overrideNote}`)
    if (ctx.adminReason) {
      lines.push(`  Admin reason: ${ctx.adminReason}`)
    }
  }

  lines.push("")
  lines.push(
    "Use these prior decisions as reference. Admin-overridden decisions are stronger signals than LLM-only decisions."
  )

  return lines.join("\n")
}
