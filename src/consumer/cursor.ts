import { BadRequestException } from "@nestjs/common"
import { z } from "zod"

import type { EventCursor } from "../data/types.js"

const postgresTimestamp = z
  .string()
  .refine(
    (value) =>
      /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(
        value
      ) && !Number.isNaN(Date.parse(value)),
    "invalid timestamp"
  )
const cursorSchema = z
  .strictObject({
    after_start: postgresTimestamp,
    after_id: z.uuid(),
    sort: z.enum(["latest", "price-asc", "rating-desc"]).optional(),
    price: z
      .string()
      .regex(/^-?\d+(?:\.\d+)?$/)
      .nullable()
      .optional(),
    rating: z
      .string()
      .regex(/^\d+(?:\.\d+)?$/)
      .optional(),
    rating_count: z.number().int().nonnegative().optional(),
  })
  .refine((value) =>
    value.sort === "price-asc"
      ? value.price !== undefined && value.rating === undefined && value.rating_count === undefined
      : value.sort === "rating-desc"
        ? value.rating !== undefined &&
          value.rating_count !== undefined &&
          value.price === undefined
        : value.price === undefined &&
          value.rating === undefined &&
          value.rating_count === undefined
  )

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export function encodeCursor(cursor: EventCursor): string {
  return Buffer.from(
    JSON.stringify({
      after_start: cursor.startDatetime,
      after_id: cursor.id,
      ...(cursor.sort ? { sort: cursor.sort } : {}),
      ...(cursor.sort === "price-asc" ? { price: cursor.price ?? null } : {}),
      ...(cursor.sort === "rating-desc"
        ? { rating: cursor.rating ?? "0", rating_count: cursor.ratingCount ?? 0 }
        : {}),
    })
  ).toString("base64")
}

export function decodeCursor(encoded: string): EventCursor {
  if (encoded.length === 0 || !BASE64_PATTERN.test(encoded)) {
    throw new BadRequestException("invalid cursor")
  }

  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8")
    const cursor = cursorSchema.parse(JSON.parse(decoded))
    return {
      startDatetime: cursor.after_start,
      id: cursor.after_id,
      ...(cursor.sort ? { sort: cursor.sort } : {}),
      ...(cursor.sort === "price-asc" ? { price: cursor.price ?? null } : {}),
      ...(cursor.sort === "rating-desc"
        ? { rating: cursor.rating, ratingCount: cursor.rating_count }
        : {}),
    }
  } catch {
    throw new BadRequestException("invalid cursor")
  }
}
