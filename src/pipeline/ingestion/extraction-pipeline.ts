// Extraction-mode plan + ParsedEvent validation. Ported from
// family-events-backend supabase/functions/scrape-source/lib/extraction-pipeline.ts (U28).
// Deviations (PR #14 review): validateParsedEvents rejects ISO strings with
// impossible calendar components (Date.parse rolls 2026-02-30 forward), and
// the LLM row mapping is extracted into mapLlmEventRow.

import { isoCalendarComponentsValid } from "./parsing.js"
import type { ExtractionMode, FetchedArtifact, ParsedEvent } from "./types.js"

export type ExtractorName = "deterministic" | "llm"

export function selectExtractionPlan(
  mode: ExtractionMode,
  deterministicValidCount: number
): ExtractorName[] {
  if (mode === "deterministic") return ["deterministic"]
  if (mode === "llm") return ["llm"]
  return deterministicValidCount > 0 ? ["deterministic"] : ["deterministic", "llm"]
}

function parseableDatetime(value: string): boolean {
  return isoCalendarComponentsValid(value) && !Number.isNaN(Date.parse(value))
}

export function validateParsedEvents(events: ParsedEvent[]): ParsedEvent[] {
  return events.filter((event) => {
    if (!event.title?.trim() || !event.startDatetime) return false
    if (!parseableDatetime(event.startDatetime)) return false
    if (event.endDatetime && !parseableDatetime(event.endDatetime)) {
      return false
    }
    return true
  })
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function mapLlmEventRow(row: unknown): ParsedEvent {
  if (!row || typeof row !== "object") {
    throw new Error("LLM event row is not an object")
  }
  const record = row as Record<string, unknown>
  if (typeof record.title !== "string" || typeof record.startDatetime !== "string") {
    throw new Error("LLM event row missing required ParsedEvent fields")
  }

  return {
    title: record.title,
    description: typeof record.description === "string" ? record.description : "",
    startDatetime: record.startDatetime,
    endDatetime: optionalString(record.endDatetime),
    venueName: optionalString(record.venueName),
    address: optionalString(record.address),
    sourceUrl: optionalString(record.sourceUrl),
    imageUrl: optionalString(record.imageUrl),
    images: Array.isArray(record.images)
      ? record.images.filter((value): value is string => typeof value === "string")
      : [],
    price: typeof record.price === "number" ? record.price : null,
    isFree: record.isFree === true,
  } satisfies ParsedEvent
}

export function parseLlmParsedEvents(rawJson: string): ParsedEvent[] {
  const parsed = JSON.parse(rawJson) as unknown
  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { events?: unknown })?.events)
      ? (parsed as { events: unknown[] }).events
      : null

  if (!rows) {
    throw new Error("LLM output must be an array of ParsedEvent rows")
  }

  const mapped = rows.map((row) => mapLlmEventRow(row))

  const valid = validateParsedEvents(mapped)
  if (valid.length !== mapped.length) {
    throw new Error("LLM output contains invalid ParsedEvent rows")
  }

  return valid
}

export function normalizeArtifactForLlm(artifact: FetchedArtifact): string {
  return artifact.body.replace(/\s+/g, " ").trim().slice(0, 20_000)
}
