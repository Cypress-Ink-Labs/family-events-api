import { BadRequestException } from "@nestjs/common"
import { z } from "zod"

const page = z.coerce.number().int().min(0).max(1000000).default(0)
const filter = z.enum(["all", "pending", "flagged", "approved"]).default("all")
const update = z
  .strictObject({
    body: z.string().trim().min(1).max(4000).optional(),
    is_approved: z.boolean().optional(),
    is_flagged: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0)
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new BadRequestException("invalid contribution request")
  return result.data
}
export type CommentUpdate = z.infer<typeof update>
export const parseContributionId = (value: unknown) => parse(z.uuid(), value)
export const parseCommentUpdate = (value: unknown) => parse(update, value)
export const parseCommentPage = (value: unknown) => parse(z.strictObject({ page, filter }), value)
export const parseRatingPage = (value: unknown) => parse(z.strictObject({ page }), value)
