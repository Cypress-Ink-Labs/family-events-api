import { BadRequestException } from "@nestjs/common"
import { z } from "zod"
import { parseAdminEventsQuery } from "./admin-review.input.js"
const limit = z.coerce.number().int().min(1).max(200)
const runs = z.strictObject({
  source_id: z.uuid().optional(),
  status: z.enum(["running", "success", "error", "partial"]).optional(),
  limit: limit.default(50),
  after_started_at: z.string().optional(),
  after_id: z.uuid().optional(),
})
const queues = z.strictObject({
  kind: z.enum(["source", "tag"]),
  source_id: z.uuid().optional(),
  limit: limit.default(100),
  after_id: z
    .string()
    .regex(/^[1-9]\d{0,18}$/)
    .refine((value) => /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n)
    .optional(),
})
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success)
    throw new BadRequestException({
      statusCode: 400,
      message: "invalid query parameters",
      error: "Bad Request",
      issues: result.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    })
  return result.data
}
export function parseSourceRunsQuery(input: unknown) {
  const value = parse(runs, input)
  parseAdminEventsQuery({
    ...(value.after_started_at === undefined ? {} : { after_created_at: value.after_started_at }),
    ...(value.after_id === undefined ? {} : { after_id: value.after_id }),
  })
  return value
}
export function parseSourceQueuesQuery(input: unknown) {
  return parse(queues, input)
}
export type SourceRunsQuery = ReturnType<typeof parseSourceRunsQuery>
export type SourceQueuesQuery = ReturnType<typeof parseSourceQueuesQuery>
