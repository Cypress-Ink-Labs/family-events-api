import { createHash, randomBytes } from "node:crypto"
import { z } from "zod"

export const CORRECTION_CATEGORIES = [
  "cancellation",
  "wrong_date_time",
  "wrong_location",
  "wrong_cost",
  "accessibility",
  "other",
] as const

const schema = z
  .object({
    category: z.enum(CORRECTION_CATEGORIES),
    details: z.string().trim().min(1).max(2000),
    contact: z
      .object({
        email: z.string().email().max(320).optional(),
        phone: z
          .string()
          .trim()
          .regex(/^\+?[0-9 ()-]{7,32}$/)
          .refine((value) => (value.match(/[0-9]/g)?.length ?? 0) >= 7, {
            message: "Phone number must contain at least seven digits",
          })
          .optional(),
      })
      .strict()
      .refine((value) => value.email !== undefined || value.phone !== undefined)
      .optional(),
    evidence_urls: z
      .array(
        z
          .string()
          .url()
          .max(2048)
          .refine((value) => /^https?:\/\//.test(value))
      )
      .max(5)
      .optional(),
  })
  .strict()

export type CorrectionReportInput = z.infer<typeof schema>

export function parseCorrectionReport(body: unknown): CorrectionReportInput {
  return schema.parse(body)
}

export function newAnonymousCapability(): string {
  return randomBytes(32).toString("base64url")
}

export function capabilityHash(token: string): Buffer {
  return createHash("sha256").update(`correction-report-capability:${token}`).digest()
}

export function contentDigest(eventId: string, input: CorrectionReportInput): Buffer {
  // Keep this canonical representation deliberately limited to public report
  // content. Contact and evidence must neither affect deduplication nor leak
  // into a value that may be retained after their private row is removed.
  const canonical = JSON.stringify({
    category: input.category,
    details: input.details.normalize("NFC"),
    event_id: eventId.toLowerCase(),
  })
  return createHash("sha256").update(`correction-report-content:v1:${canonical}`).digest()
}
