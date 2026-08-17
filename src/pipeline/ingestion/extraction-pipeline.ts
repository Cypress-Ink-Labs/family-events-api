// Extraction-mode plan + ParsedEvent validation. Ported verbatim from
// family-events-backend supabase/functions/scrape-source/lib/extraction-pipeline.ts (U28).

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

export function validateParsedEvents(events: ParsedEvent[]): ParsedEvent[] {
  return events.filter((event) => {
    if (!event.title?.trim() || !event.startDatetime) return false
    if (Number.isNaN(Date.parse(event.startDatetime))) return false
    if (event.endDatetime && Number.isNaN(Date.parse(event.endDatetime))) {
      return false
    }
    return true
  })
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

  const mapped = rows.map((row) => {
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
      endDatetime: typeof record.endDatetime === "string" ? record.endDatetime : null,
      venueName: typeof record.venueName === "string" ? record.venueName : null,
      address: typeof record.address === "string" ? record.address : null,
      sourceUrl: typeof record.sourceUrl === "string" ? record.sourceUrl : null,
      imageUrl: typeof record.imageUrl === "string" ? record.imageUrl : null,
      images: Array.isArray(record.images)
        ? record.images.filter((value): value is string => typeof value === "string")
        : [],
      price: typeof record.price === "number" ? record.price : null,
      isFree: record.isFree === true,
    } satisfies ParsedEvent
  })

  const valid = validateParsedEvents(mapped)
  if (valid.length !== mapped.length) {
    throw new Error("LLM output contains invalid ParsedEvent rows")
  }

  return valid
}

export function normalizeArtifactForLlm(artifact: FetchedArtifact): string {
  return artifact.body.replace(/\s+/g, " ").trim().slice(0, 20_000)
}
