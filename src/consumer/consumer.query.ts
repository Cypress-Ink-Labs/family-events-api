import { BadRequestException } from "@nestjs/common"
import { z } from "zod"

import type { EventCursor } from "../data/types.js"
import { decodeCursor } from "./cursor.js"

const integerString = z.string().regex(/^\d+$/)
const querySchema = z.strictObject({
  city_id: z.uuid().optional(),
  keyword: z.string().trim().min(1).optional(),
  date_from: z.iso.datetime({ offset: true }).optional(),
  date_to: z.iso.datetime({ offset: true }).optional(),
  is_free: z.enum(["true", "false"]).optional(),
  kid_age: integerString.optional(),
  cursor: z.string().min(1).optional(),
  limit: integerString.optional(),
})
const eventIdSchema = z.uuid()

export interface ExploreQuery {
  cityId: string | null
  keyword: string | null
  dateFrom: string | null
  dateTo: string | null
  isFree: boolean | null
  kidAge: number | null
  after: EventCursor | null
  limit: number
}

export function parseExploreQuery(query: unknown): ExploreQuery {
  const result = querySchema.safeParse(query)
  if (!result.success) {
    throw new BadRequestException("invalid query parameters")
  }

  const limit = result.data.limit === undefined ? 24 : Number(result.data.limit)
  const kidAge = result.data.kid_age === undefined ? null : Number(result.data.kid_age)
  if (
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(limit) ||
    (kidAge !== null && !Number.isSafeInteger(kidAge))
  ) {
    throw new BadRequestException("invalid query parameters")
  }

  return {
    cityId: result.data.city_id ?? null,
    keyword: result.data.keyword ?? null,
    dateFrom: result.data.date_from ?? null,
    dateTo: result.data.date_to ?? null,
    isFree: result.data.is_free === undefined ? null : result.data.is_free === "true",
    kidAge,
    after: result.data.cursor === undefined ? null : decodeCursor(result.data.cursor),
    limit,
  }
}

export function parseEventId(id: string): string {
  const result = eventIdSchema.safeParse(id)
  if (!result.success) throw new BadRequestException("invalid event id")
  return result.data
}
