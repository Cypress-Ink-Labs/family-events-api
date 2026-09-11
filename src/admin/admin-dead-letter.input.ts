import { BadRequestException, HttpStatus } from "@nestjs/common"
import { z } from "zod"

export const DEAD_LETTER_QUEUES = ["source", "tag"] as const
export type DeadLetterQueue = (typeof DEAD_LETTER_QUEUES)[number]
export interface DeadLetterCursor {
  finishedAt: string | null
  id: string
}
export interface DeadLetterListInput {
  queue: DeadLetterQueue
  limit: number
  cursor: DeadLetterCursor | null
}

const decimalId = z
  .string()
  .regex(/^[1-9]\d*$/, "must be a canonical positive decimal string")
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n, "must fit PostgreSQL bigint")
const rawTimestamp = z.string().refine((value) => {
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
}, "must be a valid timestamp with timezone and at most six fractional digits")
const cursorPayload = z.strictObject({ finished_at: rawTimestamp.nullable(), id: decimalId })

function invalid(
  kind: "query parameters" | "path parameters" | "request body",
  issues: z.core.$ZodIssue[]
): never {
  throw new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    message: `invalid ${kind}`,
    error: "Bad Request",
    issues: issues.map((issue) => ({
      path:
        issue.code === "unrecognized_keys"
          ? [...issue.path, issue.keys[0] ?? ""].map(String).filter(Boolean).join(".")
          : issue.path.map(String).filter(Boolean).join("."),
      message: issue.message,
    })),
  })
}

export function encodeDeadLetterCursor(cursor: DeadLetterCursor): string {
  return Buffer.from(
    JSON.stringify({ finished_at: cursor.finishedAt, id: cursor.id }),
    "utf8"
  ).toString("base64url")
}

function decodeCursor(value: string): unknown {
  try {
    const canonical = Buffer.from(value, "base64url").toString("base64url")
    if (canonical !== value) throw new Error("non-canonical base64url")
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
  } catch {
    return undefined
  }
}

export function parseDeadLetterListQuery(query: unknown): DeadLetterListInput {
  const schema = z.strictObject({
    queue: z.enum(DEAD_LETTER_QUEUES),
    limit: z
      .string()
      .regex(/^[1-9]\d*$/, "must be an integer")
      .transform(Number)
      .pipe(z.number().int().min(1).max(50))
      .optional()
      .default(25),
    cursor: z.string().min(1).transform(decodeCursor).pipe(cursorPayload).optional(),
  })
  const result = schema.safeParse(query)
  if (!result.success) invalid("query parameters", result.error.issues)
  return {
    queue: result.data.queue,
    limit: result.data.limit,
    cursor:
      result.data.cursor === undefined
        ? null
        : { finishedAt: result.data.cursor.finished_at, id: result.data.cursor.id },
  }
}

export function parseDeadLetterPath(
  queue: unknown,
  id: unknown
): { queue: DeadLetterQueue; id: string } {
  const result = z
    .strictObject({ queue: z.enum(DEAD_LETTER_QUEUES), id: decimalId })
    .safeParse({ queue, id })
  if (!result.success) invalid("path parameters", result.error.issues)
  return result.data
}

export function parseEmptyDeadLetterBody(body: unknown): void {
  const result = z.union([z.undefined(), z.strictObject({})]).safeParse(body)
  if (!result.success) invalid("request body", result.error.issues)
}
