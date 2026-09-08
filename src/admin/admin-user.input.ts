import { BadRequestException, HttpStatus } from "@nestjs/common"
import { z } from "zod"

const uuid = z.uuid().transform((value) => value.toLowerCase())
const emptyObject = z.strictObject({})
const emptyBody = z.union([z.undefined(), emptyObject])
const accessBody = z.strictObject({
  is_enabled: z.boolean(),
  disabled_reason: z
    .string()
    .trim()
    .max(1000)
    .nullable()
    .optional()
    .transform((value) => value || null),
})

export interface AdminSetUserAccessInput {
  isEnabled: boolean
  disabledReason: string | null
}

function parse<T>(
  schema: z.ZodType<T>,
  input: unknown,
  message: "invalid request body" | "invalid query parameters" | "invalid user id"
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

export function parseAdminUserId(id: unknown): string {
  return parse(uuid, id, "invalid user id")
}

export function parseAdminUsersQuery(query: unknown): void {
  parse(emptyObject, query, "invalid query parameters")
}

export function parseAdminSetUserAccessBody(body: unknown): AdminSetUserAccessInput {
  const input = parse(accessBody, body, "invalid request body")
  return {
    isEnabled: input.is_enabled,
    disabledReason: input.is_enabled ? null : input.disabled_reason,
  }
}

export function parseAdminDeleteUserBody(body: unknown): void {
  parse(emptyBody, body, "invalid request body")
}
