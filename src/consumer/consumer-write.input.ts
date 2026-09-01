import { BadRequestException, HttpStatus } from "@nestjs/common"
import { z } from "zod"

const uuidSchema = z.uuid()
const toggleSchema = z.strictObject({ on: z.boolean() })
const ratingSchema = z.strictObject({ score: z.int().min(1).max(5) })
const commentSchema = z.strictObject({ body: z.string().trim().min(1).max(4000) })
const nullableString = z.string().optional().nullable()
const nullableInteger = z.int().min(0).optional().nullable()
const communityEventSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(200),
    description: nullableString,
    startDatetime: z.iso.datetime({ offset: true }),
    endDatetime: z.iso.datetime({ offset: true }).optional().nullable(),
    venueName: nullableString,
    address: nullableString,
    cityId: uuidSchema,
    ageMin: nullableInteger,
    ageMax: nullableInteger,
    isFree: z.boolean().optional(),
    price: z.number().min(0).optional().nullable(),
  })
  .refine(
    (input) =>
      input.endDatetime === undefined ||
      input.endDatetime === null ||
      // Compare instants: the fields independently allow any UTC offset, so
      // lexical string order is not meaningful across mixed offsets.
      Date.parse(input.endDatetime) > Date.parse(input.startDatetime),
    {
      message: "endDatetime must be after startDatetime",
      path: ["endDatetime"],
    }
  )
  .refine(
    (input) =>
      input.ageMin === undefined ||
      input.ageMin === null ||
      input.ageMax === undefined ||
      input.ageMax === null ||
      input.ageMin <= input.ageMax,
    { message: "ageMin must be less than or equal to ageMax", path: ["ageMax"] }
  )
const preferredCitiesSchema = z
  .strictObject({
    city_ids: z.array(uuidSchema).min(1),
    primary_city_id: uuidSchema,
  })
  .refine((input) => input.city_ids.includes(input.primary_city_id))

export type ToggleInput = z.infer<typeof toggleSchema>
export type RatingInput = z.infer<typeof ratingSchema>
export type CommentInput = z.infer<typeof commentSchema>
export type CommunityEventRequest = z.infer<typeof communityEventSchema>
export type PreferredCitiesInput = z.infer<typeof preferredCitiesSchema>

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body)
  if (!result.success) {
    throw new BadRequestException({
      statusCode: HttpStatus.BAD_REQUEST,
      message: "invalid request body",
      error: "Bad Request",
      issues: result.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    })
  }
  return result.data
}

export function parseToggleInput(body: unknown): ToggleInput {
  return parseBody(toggleSchema, body)
}

export function parseRatingInput(body: unknown): RatingInput {
  return parseBody(ratingSchema, body)
}

export function parseCommentInput(body: unknown): CommentInput {
  return parseBody(commentSchema, body)
}

export function parseCommunityEventInput(body: unknown): CommunityEventRequest {
  return parseBody(communityEventSchema, body)
}

export function parsePreferredCitiesInput(body: unknown): PreferredCitiesInput {
  return parseBody(preferredCitiesSchema, body)
}

export function parseWriteId(id: string): string {
  const result = uuidSchema.safeParse(id)
  if (!result.success) throw new BadRequestException("invalid id")
  return result.data
}
