import { BadRequestException, HttpStatus } from "@nestjs/common"
import { z } from "zod"

import { scheduledOperations } from "../pipeline/scheduled-operations.js"

export const CRON_LABELS = scheduledOperations().map((operation) => operation.label)

const BIGINT_MAX = 9_223_372_036_854_775_807n
const label = z.string().refine((value) => CRON_LABELS.includes(value), "unknown cron label")
const limit = z
  .string()
  .regex(/^[1-9]\d*$/, "must be an integer")
  .transform(Number)
  .pipe(z.number().int().min(1).max(200))
const runId = z
  .string()
  .regex(/^[1-9]\d*$/, "must be a canonical positive decimal string")
  .refine(
    (value) => !/^[1-9]\d*$/.test(value) || BigInt(value) <= BIGINT_MAX,
    "must fit PostgreSQL bigint"
  )
const emptyQuery = z.strictObject({})
const runsQuery = z.strictObject({ label: label.optional(), limit: limit.optional() })

function parse<T>(
  schema: z.ZodType<T>,
  input: unknown,
  message:
    | "invalid query parameters"
    | "invalid cron run id"
    | "invalid request body"
    | "invalid cron label"
): T {
  const result = schema.safeParse(input)
  if (!result.success) {
    throw new BadRequestException({
      statusCode: HttpStatus.BAD_REQUEST,
      message,
      error: "Bad Request",
      issues: result.error.issues.map((issue) => {
        const path =
          issue.code === "unrecognized_keys" ? [...issue.path, issue.keys[0] ?? ""] : issue.path
        return {
          path: path.map(String).filter(Boolean).join("."),
          message: issue.message,
        }
      }),
    })
  }
  return result.data
}

export function parseCronListQuery(query: unknown): void {
  parse(emptyQuery, query, "invalid query parameters")
}

export function parseCronRunsQuery(query: unknown): { label?: string; limit: number } {
  const input = parse(runsQuery, query, "invalid query parameters")
  return { ...(input.label === undefined ? {} : { label: input.label }), limit: input.limit ?? 50 }
}

export function parseCronRunId(raw: unknown): string {
  return parse(runId, raw, "invalid cron run id")
}

export function parseCronLabel(raw: unknown): string {
  return parse(label, raw, "invalid cron label")
}
export function parseCronOwner(body: unknown) {
  return parse(
    z.strictObject({ owner: z.enum(["api", "legacy", "paused"]) }),
    body,
    "invalid request body"
  ).owner
}
export function parseCronRunBody(body: unknown): void {
  parse(emptyQuery, body, "invalid request body")
}
