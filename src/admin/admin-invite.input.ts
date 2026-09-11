import { BadRequestException, HttpStatus } from "@nestjs/common"
import { z } from "zod"

const uuid = z.uuid().transform((value) => value.toLowerCase())
const emptyObject = z.strictObject({})
const emptyBody = z.union([z.undefined(), emptyObject])
const requestStatus = z.enum(["pending", "approved", "rejected", "all"])
const requestQuery = z.strictObject({ status: requestStatus.optional() })
const rejectBody = z.strictObject({
  notes: z
    .string()
    .trim()
    .max(1000)
    .nullable()
    .optional()
    .transform((value) => value || null),
})
const createBody = z.strictObject({
  max_uses: z.number().int().min(1).max(10_000),
  expires_at: z.iso.datetime({ offset: true }).nullable().optional(),
  notes: z
    .string()
    .trim()
    .max(1000)
    .nullable()
    .optional()
    .transform((value) => value || null),
})

export interface AdminCreateInviteCodeInput {
  maxUses: number
  expiresAt?: string | null
  notes?: string | null
}

export type AdminInviteRequestStatus = z.infer<typeof requestStatus>
export interface AdminRejectInviteRequestInput {
  notes?: string | null
}

function parse<T>(schema: z.ZodType<T>, input: unknown, message: string): T {
  const result = schema.safeParse(input)
  if (!result.success) {
    throw new BadRequestException({
      statusCode: HttpStatus.BAD_REQUEST,
      message,
      error: "Bad Request",
      issues: result.error.issues.map((issue) => ({
        path: (issue.code === "unrecognized_keys"
          ? [...issue.path, issue.keys[0] ?? ""]
          : issue.path
        )
          .map(String)
          .filter(Boolean)
          .join("."),
        message: issue.message,
      })),
    })
  }
  return result.data
}

export function parseAdminInviteCodeId(value: unknown): string {
  return parse(uuid, value, "invalid invite code id")
}

export function parseAdminInviteRequestId(value: unknown): string {
  return parse(uuid, value, "invalid invite request id")
}

export function parseAdminInviteRequestQuery(query: unknown): AdminInviteRequestStatus {
  return parse(requestQuery, query, "invalid query parameters").status ?? "pending"
}

export function parseAdminApproveInviteRequestBody(body: unknown): void {
  parse(emptyBody, body, "invalid request body")
}

export function parseAdminRejectInviteRequestBody(body: unknown): AdminRejectInviteRequestInput {
  const value = parse(rejectBody, body, "invalid request body")
  const supplied = typeof body === "object" && body !== null ? body : {}
  return Object.hasOwn(supplied, "notes") ? { notes: value.notes } : {}
}

export function parseAdminInviteQuery(query: unknown): void {
  parse(emptyObject, query, "invalid query parameters")
}

export function parseAdminCreateInviteCodeBody(body: unknown): AdminCreateInviteCodeInput {
  const value = parse(createBody, body, "invalid request body")
  const supplied = typeof body === "object" && body !== null ? body : {}
  return {
    maxUses: value.max_uses,
    ...(Object.hasOwn(supplied, "expires_at") ? { expiresAt: value.expires_at } : {}),
    ...(Object.hasOwn(supplied, "notes") ? { notes: value.notes } : {}),
  }
}

export function parseAdminRevokeInviteCodeBody(body: unknown): void {
  parse(emptyBody, body, "invalid request body")
}
