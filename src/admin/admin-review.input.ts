import { BadRequestException, HttpStatus } from "@nestjs/common"
import { z } from "zod"

export const ADMIN_STATUSES = ["draft", "published", "rejected", "archived"] as const
export const LLM_REVIEW_STATUSES = [
  "not_required",
  "pending",
  "succeeded",
  "failed",
  "skipped",
] as const
export const LLM_REVIEW_DECISIONS = ["approve", "reject", "needs_admin_review"] as const
export type AdminStatus = (typeof ADMIN_STATUSES)[number]
export type LlmReviewStatus = (typeof LLM_REVIEW_STATUSES)[number]
export type LlmReviewDecision = (typeof LLM_REVIEW_DECISIONS)[number]

const uuid = z.uuid().transform((value) => value.toLowerCase())
const status = z.enum(ADMIN_STATUSES)
const keyword = z
  .string()
  .trim()
  .max(100)
  .transform((value) => value || null)
  .optional()
const booleanQuery = z
  .enum(["true", "false"])
  .transform((value) => value === "true")
  .optional()
const timestamp = z.string().refine((value) => {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](?:0\d|1[0-5])(?::?[0-5]\d)?)$/.exec(
      value
    )
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return (
    year > 0 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days[month - 1]! &&
    Number(match[4]) <= 23 &&
    Number(match[5]) <= 59 &&
    Number(match[6]) <= 59
  )
}, "must be a valid timestamp with a timezone and at most six fractional digits")
const eventsQuery = z
  .strictObject({
    status: status.optional(),
    city_id: uuid.optional(),
    city_is_null: booleanQuery,
    keyword,
    after_created_at: timestamp.optional(),
    after_id: uuid.optional(),
    limit: z.string().regex(/^\d+$/).transform(Number).pipe(z.int().min(1).max(500)).optional(),
    llm_review_status: z.enum(LLM_REVIEW_STATUSES).optional(),
    llm_review_decision: z.enum(LLM_REVIEW_DECISIONS).optional(),
    llm_reviewed: booleanQuery,
    source_id: uuid.optional(),
  })
  .refine((input) => (input.after_created_at === undefined) === (input.after_id === undefined), {
    message: "cursor requires after_created_at and after_id",
    path: ["after_created_at"],
  })
const facetsQuery = z.strictObject({ keyword })
const statusBody = z.strictObject({
  status,
  reason: z
    .string()
    .trim()
    .max(1000)
    .nullable()
    .optional()
    .transform((value) => value || null),
})
// Validate submitted length and every UUID before deduplicating.
const eventIds = z
  .array(uuid)
  .min(1)
  .max(500)
  .transform((ids) => [...new Set(ids)])
const bulkStatusBody = z.strictObject({ event_ids: eventIds, status })
const bulkDeleteBody = z.strictObject({ event_ids: eventIds })

export interface AdminEventsInput {
  status: AdminStatus | null
  cityId: string | null
  cityIsNull: boolean | null
  keyword: string | null
  afterCreatedAt: string | null
  afterId: string | null
  limit: number
  llmReviewStatus: LlmReviewStatus | null
  llmReviewDecision: LlmReviewDecision | null
  llmReviewed: boolean | null
  sourceId: string | null
}

function parse<T>(schema: z.ZodType<T>, input: unknown, location: "body" | "query" | "id"): T {
  const result = schema.safeParse(input)
  if (!result.success) {
    throw new BadRequestException({
      statusCode: HttpStatus.BAD_REQUEST,
      message:
        location === "body"
          ? "invalid request body"
          : location === "query"
            ? "invalid query parameters"
            : "invalid event id",
      error: "Bad Request",
      issues: result.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    })
  }
  return result.data
}

export function parseAdminEventsQuery(query: unknown): AdminEventsInput {
  const input = parse(eventsQuery, query, "query")
  return {
    status: input.status ?? null,
    cityId: input.city_id ?? null,
    cityIsNull: input.city_is_null ?? null,
    keyword: input.keyword ?? null,
    afterCreatedAt: input.after_created_at ?? null,
    afterId: input.after_id ?? null,
    limit: input.limit ?? 200,
    llmReviewStatus: input.llm_review_status ?? null,
    llmReviewDecision: input.llm_review_decision ?? null,
    llmReviewed: input.llm_reviewed ?? null,
    sourceId: input.source_id ?? null,
  }
}

export function parseAdminFacetsQuery(query: unknown): { keyword: string | null } {
  return { keyword: parse(facetsQuery, query, "query").keyword ?? null }
}

export function parseAdminStatusBody(body: unknown): {
  status: AdminStatus
  reason: string | null
} {
  return parse(statusBody, body, "body")
}

export function parseAdminBulkStatusBody(body: unknown): {
  eventIds: string[]
  status: AdminStatus
} {
  const input = parse(bulkStatusBody, body, "body")
  return { eventIds: input.event_ids, status: input.status }
}

export function parseAdminBulkDeleteBody(body: unknown): { eventIds: string[] } {
  return { eventIds: parse(bulkDeleteBody, body, "body").event_ids }
}

export function parseAdminEventId(id: unknown): string {
  return parse(uuid, id, "id")
}
