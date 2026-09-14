import { BadRequestException, HttpStatus } from "@nestjs/common"
import { z } from "zod"

import { ADMIN_STATUSES, type AdminStatus } from "./admin-review.input.js"

export const ADMIN_EDITABLE_EVENT_FIELDS = [
  "title",
  "description",
  "start_datetime",
  "end_datetime",
  "timezone",
  "venue_name",
  "address",
  "city_id",
  "latitude",
  "longitude",
  "age_min",
  "age_max",
  "price",
  "is_free",
  "admission_cost_state",
  "admission_amount",
  "admission_cost_evidence",
  "is_outdoor",
  "source_url",
  "source_name",
  "source_id",
  "images",
  "status",
  "recurrence_info",
  "is_featured",
] as const

const uuid = z.uuid().transform((value) => value.toLowerCase())
const timestamp = z.string().refine((value) => {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](?:0\d|1[0-5])(?::?[0-5]\d)?)$/.exec(
      value
    )
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return (
    year > 0 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days[month - 1]! &&
    Number(match[4]) <= 23 &&
    Number(match[5]) <= 59 &&
    Number(match[6]) <= 59
  )
}, "must be a valid timestamp with a timezone and at most six fractional digits")
const nullableText = (maximum: number) => z.string().max(maximum).nullable()
const nullableUuid = uuid.nullable()
const nullableNumber = z.number().finite().nullable()
const httpUrl = z
  .url()
  .max(2048)
  .refine((value) => {
    const protocol = new URL(value).protocol
    return protocol === "http:" || protocol === "https:"
  }, "must use the http or https protocol")

const eventPatch = z
  .strictObject({
    title: z.string().trim().min(1).max(500).optional(),
    description: nullableText(10_000).optional(),
    start_datetime: timestamp.optional(),
    end_datetime: timestamp.nullable().optional(),
    timezone: z.string().trim().min(1).max(100).optional(),
    venue_name: nullableText(300).optional(),
    address: nullableText(500).optional(),
    city_id: nullableUuid.optional(),
    latitude: nullableNumber
      .refine((value) => value === null || (value >= -90 && value <= 90))
      .optional(),
    longitude: nullableNumber
      .refine((value) => value === null || (value >= -180 && value <= 180))
      .optional(),
    age_min: z.number().int().min(0).nullable().optional(),
    age_max: z.number().int().min(0).nullable().optional(),
    price: z.number().finite().min(0).max(99_999_999.99).nullable().optional(),
    is_free: z.boolean().optional(),
    admission_cost_state: z.enum(["free", "paid", "unknown"]).optional(),
    admission_amount: z.number().finite().min(0).max(99_999_999.99).nullable().optional(),
    admission_cost_evidence: nullableText(2_000).optional(),
    is_outdoor: z.boolean().nullable().optional(),
    source_url: httpUrl.nullable().optional(),
    source_name: nullableText(300).optional(),
    source_id: nullableUuid.optional(),
    images: z.array(httpUrl).max(20).optional(),
    status: z.enum(ADMIN_STATUSES).optional(),
    recurrence_info: z.json().nullable().optional(),
    is_featured: z.boolean().optional(),
  })
  .superRefine((patch, context) => {
    if (
      patch.start_datetime !== undefined &&
      patch.end_datetime != null &&
      new Date(patch.end_datetime) <= new Date(patch.start_datetime)
    ) {
      context.addIssue({
        code: "custom",
        path: ["end_datetime"],
        message: "must be after start_datetime",
      })
    }
    if (patch.age_min != null && patch.age_max != null && patch.age_min > patch.age_max) {
      context.addIssue({
        code: "custom",
        path: ["age_max"],
        message: "must be greater than or equal to age_min",
      })
    }
  })

const tagIds = z
  .array(uuid)
  .max(500)
  .transform((ids) => [...new Set(ids)])

const updateBody = z.strictObject({
  patch: eventPatch,
  tag_ids: tagIds,
  lock_edited_fields: z.boolean().optional().default(true),
  decision_reason: z
    .string()
    .trim()
    .max(1000)
    .nullable()
    .optional()
    .transform((value) => value || null),
})
const emptyBody = z.union([z.undefined(), z.strictObject({})])

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export interface AdminEventPatch {
  title?: string
  description?: string | null
  startDatetime?: string
  endDatetime?: string | null
  timezone?: string
  venueName?: string | null
  address?: string | null
  cityId?: string | null
  latitude?: number | null
  longitude?: number | null
  ageMin?: number | null
  ageMax?: number | null
  price?: number | null
  isFree?: boolean
  admissionCostState?: "free" | "paid" | "unknown"
  admissionAmount?: number | null
  admissionCostEvidence?: string | null
  isOutdoor?: boolean | null
  sourceUrl?: string | null
  sourceName?: string | null
  sourceId?: string | null
  images?: string[]
  status?: AdminStatus
  recurrenceInfo?: JsonValue
  isFeatured?: boolean
}

export interface AdminUpdateEventInput {
  patch: AdminEventPatch
  tagIds: string[]
  lockEditedFields: boolean
  decisionReason: string | null
}

function invalidBody(error: z.ZodError): BadRequestException {
  return new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    message: "invalid request body",
    error: "Bad Request",
    issues: error.issues.map((issue) => {
      const path =
        issue.code === "unrecognized_keys" ? [...issue.path, issue.keys[0] ?? ""] : issue.path
      return {
        path: path.map(String).filter(Boolean).join("."),
        message: issue.message,
      }
    }),
  })
}

export function parseAdminUpdateEventBody(body: unknown): AdminUpdateEventInput {
  const result = updateBody.safeParse(body)
  if (!result.success) throw invalidBody(result.error)
  const { patch } = result.data
  return {
    patch: {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.start_datetime !== undefined ? { startDatetime: patch.start_datetime } : {}),
      ...(patch.end_datetime !== undefined ? { endDatetime: patch.end_datetime } : {}),
      ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
      ...(patch.venue_name !== undefined ? { venueName: patch.venue_name } : {}),
      ...(patch.address !== undefined ? { address: patch.address } : {}),
      ...(patch.city_id !== undefined ? { cityId: patch.city_id } : {}),
      ...(patch.latitude !== undefined ? { latitude: patch.latitude } : {}),
      ...(patch.longitude !== undefined ? { longitude: patch.longitude } : {}),
      ...(patch.age_min !== undefined ? { ageMin: patch.age_min } : {}),
      ...(patch.age_max !== undefined ? { ageMax: patch.age_max } : {}),
      ...(patch.price !== undefined ? { price: patch.price } : {}),
      ...(patch.is_free !== undefined ? { isFree: patch.is_free } : {}),
      ...(patch.admission_cost_state !== undefined
        ? { admissionCostState: patch.admission_cost_state }
        : {}),
      ...(patch.admission_amount !== undefined ? { admissionAmount: patch.admission_amount } : {}),
      ...(patch.admission_cost_evidence !== undefined
        ? { admissionCostEvidence: patch.admission_cost_evidence }
        : {}),
      ...(patch.is_outdoor !== undefined ? { isOutdoor: patch.is_outdoor } : {}),
      ...(patch.source_url !== undefined ? { sourceUrl: patch.source_url } : {}),
      ...(patch.source_name !== undefined ? { sourceName: patch.source_name } : {}),
      ...(patch.source_id !== undefined ? { sourceId: patch.source_id } : {}),
      ...(patch.images !== undefined ? { images: patch.images } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.recurrence_info !== undefined ? { recurrenceInfo: patch.recurrence_info } : {}),
      ...(patch.is_featured !== undefined ? { isFeatured: patch.is_featured } : {}),
    },
    tagIds: result.data.tag_ids,
    lockEditedFields: result.data.lock_edited_fields,
    decisionReason: result.data.decision_reason,
  }
}

export function parseAdminUnlockEventBody(body: unknown): void {
  const result = emptyBody.safeParse(body)
  if (!result.success) throw invalidBody(result.error)
}
