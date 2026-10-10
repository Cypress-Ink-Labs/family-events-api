import { BadRequestException } from "@nestjs/common"
import { z } from "zod"

import type { DiscoverySort, EventCursor } from "../data/types.js"
import type { DiscoveryRange } from "../data/types.js"
import type { AdmissionCostFilter } from "../data/types.js"
import { FAMILY_NEED_CLAIMS, type FamilyNeedClaim } from "../evidence/family-needs.js"
import { decodeCursor } from "./cursor.js"

export const MAX_CHILD_AGE = 17
export const MAX_CHILDREN = 10
export type AgeMode = "all" | "any"

const integerString = z.string().regex(/^\d+$/)
const discoveryRange = z.enum(["today", "weekend", "upcoming", "week", "month", "past"])
const localDate = z.iso.date()
const controlsSchema = {
  sort: z.enum(["soonest", "latest", "price-asc", "rating-desc"]).optional(),
  date_start: localDate.optional(),
  date_end: localDate.optional(),
  tags: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*(,[a-z0-9]+(?:-[a-z0-9]+)*)*$/)
    .max(1000)
    .optional(),
  lat: z.string().min(1).transform(Number).pipe(z.number().min(-90).max(90)).optional(),
  lng: z.string().min(1).transform(Number).pipe(z.number().min(-180).max(180)).optional(),
  radius_km: z.string().min(1).transform(Number).pipe(z.number().positive().max(50)).optional(),
}
export interface DiscoveryControls {
  sort?: DiscoverySort
  dateStart?: string
  dateEnd?: string
  tagSlugs?: string[]
  lat?: number
  lng?: number
  radiusKm?: number
}
function parseControls(input: {
  sort?: DiscoverySort
  date_start?: string
  date_end?: string
  tags?: string
  lat?: number
  lng?: number
  radius_km?: number
  range?: string
  date_from?: string
  date_to?: string
}): DiscoveryControls {
  const dates = input.date_start !== undefined || input.date_end !== undefined
  if (
    dates &&
    (input.range !== undefined || input.date_from !== undefined || input.date_to !== undefined)
  )
    throw new BadRequestException("custom dates cannot be combined with range or timestamp bounds")
  if (input.range && (input.date_from || input.date_to))
    throw new BadRequestException("range cannot be combined with timestamp bounds")
  if (input.date_from && input.date_to && Date.parse(input.date_from) > Date.parse(input.date_to))
    throw new BadRequestException("invalid date range")
  if (input.date_start && input.date_end && input.date_start > input.date_end)
    throw new BadRequestException("invalid date range")
  const coordinates = [input.lat, input.lng, input.radius_km].filter(
    (value) => value !== undefined
  ).length
  if (coordinates > 0 && coordinates !== 3)
    throw new BadRequestException("location requires latitude, longitude and radius")
  const tags = input.tags?.split(",")
  if (tags && (tags.length > 20 || new Set(tags).size !== tags.length))
    throw new BadRequestException("invalid tags")
  return {
    ...(input.sort === undefined ? {} : { sort: input.sort }),
    ...(input.date_start === undefined ? {} : { dateStart: input.date_start }),
    ...(input.date_end === undefined ? {} : { dateEnd: input.date_end }),
    ...(tags === undefined ? {} : { tagSlugs: tags }),
    ...(input.lat === undefined
      ? {}
      : { lat: input.lat, lng: input.lng, radiusKm: input.radius_km }),
  }
}
const querySchema = z.strictObject({
  ...controlsSchema,
  city_id: z.uuid().optional(),
  keyword: z.string().trim().min(1).max(100).optional(), // legacy events-api capped keyword at 100
  range: discoveryRange.optional(),
  date_from: z.iso.datetime({ offset: true }).optional(),
  date_to: z.iso.datetime({ offset: true }).optional(),
  is_free: z.enum(["true", "false"]).optional(),
  hide_past: z.enum(["true", "false"]).optional(),
  date_overlap: z.enum(["true", "false"]).optional(),
  cost: z.enum(["any", "free", "paid", "unknown"]).optional(),
  kid_age: integerString.optional(),
  ages: z
    .string()
    .regex(/^\d+(,\d+)*$/)
    .optional(),
  age_mode: z.enum(["all", "any"]).optional(),
  include_unknown_age: z.enum(["true", "false"]).optional(),
  family_needs: z.string().min(1).optional(),
  include_unknown_family_needs: z.enum(["true", "false"]).optional(),
  cursor: z.string().min(1).optional(),
  limit: integerString.optional(),
})
const eventIdSchema = z.uuid()

export interface AgeQuery {
  ages: number[]
  ageMode: AgeMode
  includeUnknownAge: boolean
}

export interface ExploreQuery extends DiscoveryControls {
  cityId: string | null
  keyword: string | null
  range: DiscoveryRange | null
  dateFrom: string | null
  dateTo: string | null
  isFree: boolean | null
  hidePast?: boolean
  dateOverlap?: boolean
  cost?: AdmissionCostFilter
  after: EventCursor | null
  limit: number
  ages: number[]
  ageMode: AgeMode
  includeUnknownAge: boolean
  familyNeeds?: FamilyNeedClaim[]
  includeUnknownFamilyNeeds?: boolean
}

export function parseExploreQuery(query: unknown): ExploreQuery {
  const result = querySchema.safeParse(query)
  if (!result.success) {
    throw new BadRequestException("invalid query parameters")
  }

  const limit = result.data.limit === undefined ? 24 : Number(result.data.limit)
  if (limit < 1 || limit > 100 || !Number.isSafeInteger(limit)) {
    throw new BadRequestException("invalid query parameters")
  }
  const ageQuery = parseAgeQuery(result.data)
  if (result.data.cost !== undefined && result.data.is_free !== undefined) {
    throw new BadRequestException("cost cannot be combined with is_free")
  }
  if (
    result.data.range !== undefined &&
    (result.data.date_from !== undefined || result.data.date_to !== undefined)
  ) {
    throw new BadRequestException("range cannot be combined with date_from or date_to")
  }
  const usesExplicitDates =
    result.data.date_from !== undefined ||
    result.data.date_to !== undefined ||
    result.data.date_start !== undefined ||
    result.data.date_end !== undefined
  if (result.data.date_overlap === "true" && (!result.data.date_start || !result.data.date_end))
    throw new BadRequestException("date overlap requires both calendar date bounds")
  const controls = parseControls(result.data)
  const after = result.data.cursor === undefined ? null : decodeCursor(result.data.cursor)
  if (after && (after.sort ?? "soonest") !== (result.data.sort ?? "soonest"))
    throw new BadRequestException("cursor sort does not match query")

  return {
    cityId: result.data.city_id ?? null,
    keyword: result.data.keyword ?? null,
    range: usesExplicitDates ? null : (result.data.range ?? "weekend"),
    dateFrom: result.data.date_from ?? null,
    dateTo: result.data.date_to ?? null,
    isFree: result.data.is_free === undefined ? null : result.data.is_free === "true",
    ...(result.data.hide_past === undefined ? {} : { hidePast: result.data.hide_past === "true" }),
    ...(result.data.date_overlap === undefined
      ? {}
      : { dateOverlap: result.data.date_overlap === "true" }),
    cost: result.data.cost ?? "any",
    after,
    limit,
    ...controls,
    ...ageQuery,
    ...parseFamilyNeeds(result.data),
  }
}

const planQuerySchema = z.strictObject({
  city_id: z.uuid().optional(),
  kid_age: integerString.optional(),
})

const mapQuerySchema = z.strictObject({
  ...controlsSchema,
  keyword: z.string().trim().min(1).max(100).optional(),
  date_from: z.iso.datetime({ offset: true }).optional(),
  date_to: z.iso.datetime({ offset: true }).optional(),
  city_id: z.uuid().optional(),
  range: discoveryRange.optional(),
  ages: z
    .string()
    .regex(/^\d+(,\d+)*$/)
    .optional(),
  age_mode: z.enum(["all", "any"]).optional(),
  include_unknown_age: z.enum(["true", "false"]).optional(),
  family_needs: z.string().min(1).optional(),
  include_unknown_family_needs: z.enum(["true", "false"]).optional(),
  cost: z.enum(["any", "free", "paid", "unknown"]).optional(),
})

export interface MapQuery extends AgeQuery, DiscoveryControls {
  keyword?: string
  dateFrom?: string
  dateTo?: string
  cityId: string | null
  range: DiscoveryRange | null
  cost?: AdmissionCostFilter
  familyNeeds?: FamilyNeedClaim[]
  includeUnknownFamilyNeeds?: boolean
}

export function parseMapQuery(query: unknown): MapQuery {
  const result = mapQuerySchema.safeParse(query)
  if (!result.success) {
    throw new BadRequestException("invalid query parameters")
  }
  return {
    cityId: result.data.city_id ?? null,
    range:
      result.data.date_start !== undefined ||
      result.data.date_end !== undefined ||
      result.data.date_from !== undefined ||
      result.data.date_to !== undefined
        ? null
        : (result.data.range ?? "weekend"),
    ...parseControls(result.data),
    ...(result.data.keyword === undefined ? {} : { keyword: result.data.keyword }),
    ...(result.data.date_from === undefined ? {} : { dateFrom: result.data.date_from }),
    ...(result.data.date_to === undefined ? {} : { dateTo: result.data.date_to }),
    cost: result.data.cost ?? "any",
    ...parseAgeQuery(result.data),
    ...parseFamilyNeeds(result.data),
  }
}

export interface PlanQuery {
  cityId: string | null
  kidAge: number | null
}

export function parsePlanQuery(query: unknown): PlanQuery {
  const result = planQuerySchema.safeParse(query)
  if (!result.success) {
    throw new BadRequestException("invalid query parameters")
  }
  const kidAge = result.data.kid_age === undefined ? null : Number(result.data.kid_age)
  if (kidAge !== null && !Number.isSafeInteger(kidAge)) {
    throw new BadRequestException("invalid query parameters")
  }
  return {
    cityId: result.data.city_id ?? null,
    kidAge,
  }
}

export function parseEventId(id: string): string {
  const result = eventIdSchema.safeParse(id)
  if (!result.success) throw new BadRequestException("invalid event id")
  return result.data
}

function parseAgeQuery(input: {
  ages?: string
  kid_age?: string
  age_mode?: AgeMode
  include_unknown_age?: "true" | "false"
}): AgeQuery {
  if (input.ages !== undefined && input.kid_age !== undefined) {
    throw new BadRequestException("invalid query parameters")
  }

  const rawAges =
    input.ages !== undefined
      ? input.ages.split(",")
      : input.kid_age !== undefined
        ? [input.kid_age]
        : []
  const ages = rawAges.map(Number)
  const hasInvalidAge = ages.some(
    (age) => !Number.isSafeInteger(age) || age < 0 || age > MAX_CHILD_AGE
  )
  if (hasInvalidAge || ages.length > MAX_CHILDREN || new Set(ages).size !== ages.length) {
    throw new BadRequestException("invalid query parameters")
  }
  if (
    ages.length === 0 &&
    (input.age_mode !== undefined || input.include_unknown_age !== undefined)
  ) {
    throw new BadRequestException("invalid query parameters")
  }

  return {
    ages,
    ageMode: input.age_mode ?? "all",
    includeUnknownAge: input.include_unknown_age === "true",
  }
}

function parseFamilyNeeds(input: {
  family_needs?: string
  include_unknown_family_needs?: "true" | "false"
}): { familyNeeds: FamilyNeedClaim[]; includeUnknownFamilyNeeds: boolean } {
  const values = input.family_needs?.split(",") ?? []
  if (
    values.some((value) => !(FAMILY_NEED_CLAIMS as readonly string[]).includes(value)) ||
    new Set(values).size !== values.length ||
    (values.length === 0 && input.include_unknown_family_needs !== undefined)
  ) {
    throw new BadRequestException("invalid query parameters")
  }
  if (input.family_needs === undefined) {
    return {} as { familyNeeds: FamilyNeedClaim[]; includeUnknownFamilyNeeds: boolean }
  }
  return {
    familyNeeds: values as FamilyNeedClaim[],
    includeUnknownFamilyNeeds: input.include_unknown_family_needs === "true",
  }
}
