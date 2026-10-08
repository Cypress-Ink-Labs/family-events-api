import { BadRequestException } from "@nestjs/common"
import { z } from "zod"

const date = z.string().refine((value) => Number.isFinite(Date.parse(value)))
const cursorSchema = z.object({ after_start: date, after_id: z.uuid() })
const schema = z.object({
  city_id: z.uuid().optional(),
  date_from: date.optional(),
  date_to: date.optional(),
  is_free: z.enum(["true", "false"]).optional(),
  tags: z.string().optional(),
  keyword: z.string().trim().max(100).optional(),
  limit: z
    .string()
    .regex(/^[1-9]\d*$/)
    .optional(),
  cursor: z.string().min(1).max(2048).optional(),
})
export function parsePublicEventsQuery(query: unknown) {
  const result = schema.safeParse(query)
  if (!result.success) throw new BadRequestException("invalid query parameters")
  const input = result.data
  const limit = input.limit === undefined ? 20 : Number(input.limit)
  if (limit > 100) throw new BadRequestException("invalid limit")
  const tags =
    input.tags
      ?.split(",")
      .map((tag) => tag.trim())
      .filter(Boolean) ?? []
  if (tags.length > 10 || tags.some((tag) => !/^[a-z0-9-]{1,50}$/.test(tag)))
    throw new BadRequestException("invalid tags")
  let cursor: z.infer<typeof cursorSchema> | null = null
  if (input.cursor !== undefined) {
    try {
      cursor = cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, "base64").toString("utf8")))
    } catch {
      throw new BadRequestException("invalid cursor")
    }
  }
  return { ...input, limit, tags, cursor }
}
