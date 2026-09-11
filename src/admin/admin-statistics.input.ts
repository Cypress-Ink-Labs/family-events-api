import { BadRequestException, HttpStatus } from "@nestjs/common"
import { z } from "zod"

const emptyQuery = z.strictObject({})
const pipelineQuery = z.strictObject({
  window_days: z
    .string()
    .regex(/^(0|[1-9]\d*)$/, "must be an integer")
    .transform(Number)
    .pipe(z.number().int().min(1).max(365))
    .optional()
    .default(30),
})

function invalidQuery(issues: z.core.$ZodIssue[]): never {
  throw new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    message: "invalid query parameters",
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

export function parseAdminDashboardQuery(query: unknown): void {
  const result = emptyQuery.safeParse(query)
  if (!result.success) invalidQuery(result.error.issues)
}

export function parseAdminPipelineQuery(query: unknown): number {
  const result = pipelineQuery.safeParse(query)
  if (!result.success) invalidQuery(result.error.issues)
  return result.data.window_days
}
