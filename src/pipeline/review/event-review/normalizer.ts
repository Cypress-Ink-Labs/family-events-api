import type {
  ReviewEventInput,
  ReviewNormalizerOutput,
  NormalizedReviewEventInput,
} from "./types.js"

const FIELD_LIMITS = {
  title: 300,
  description: 4_000,
  venueName: 200,
  address: 300,
  sourceName: 200,
  sourceUrl: 1_000,
  category: 120,
  tag: 64,
} as const

function trimToMax(value: string | null | undefined, max: number): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.length <= max) return trimmed
  return trimmed.slice(0, max)
}

function normalizeTags(values: string[]): string[] {
  const deduped = new Set<string>()
  for (const value of values) {
    const normalized = trimToMax(value, FIELD_LIMITS.tag)
    if (!normalized) continue
    deduped.add(normalized)
    if (deduped.size >= 20) break
  }
  return [...deduped]
}

export function normalizeReviewEventInput(input: ReviewEventInput): ReviewNormalizerOutput {
  const title = trimToMax(input.title, FIELD_LIMITS.title)
  if (!title) {
    return {
      normalized: null,
      fallback: {
        code: "missing_title",
        reason: "Event title is required for LLM review.",
      },
    }
  }

  const startDatetime = trimToMax(input.startDatetime, 64)
  if (!startDatetime) {
    return {
      normalized: null,
      fallback: {
        code: "missing_start_datetime",
        reason: "Event start date/time is required for LLM review.",
      },
    }
  }

  const sourceUrl = trimToMax(input.sourceUrl, FIELD_LIMITS.sourceUrl)
  const sourceName = trimToMax(input.sourceName, FIELD_LIMITS.sourceName)
  if (!sourceUrl && !sourceName) {
    return {
      normalized: null,
      fallback: {
        code: "missing_source_reference",
        reason: "Event is missing both source URL and source name; routing to admin review.",
      },
    }
  }

  const normalized: NormalizedReviewEventInput = {
    eventId: input.eventId,
    title,
    description: trimToMax(input.description, FIELD_LIMITS.description),
    startDatetime,
    endDatetime: trimToMax(input.endDatetime, 64),
    timezone: trimToMax(input.timezone, 64),
    venueName: trimToMax(input.venueName, FIELD_LIMITS.venueName),
    address: trimToMax(input.address, FIELD_LIMITS.address),
    sourceName,
    sourceUrl,
    category: trimToMax(input.category, FIELD_LIMITS.category),
    tags: normalizeTags(input.tags),
  }

  return { normalized, fallback: null }
}
