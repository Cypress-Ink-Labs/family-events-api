import { BadRequestException } from "@nestjs/common"
import { z } from "zod"

import type { EventCursor } from "../data/types.js"
import type { DiscoveryRange } from "../data/types.js"
import type { AdmissionCostFilter } from "../data/types.js"
import { FAMILY_NEED_CLAIMS, type FamilyNeedClaim } from "../evidence/family-needs.js"
import { decodeCursor } from "./cursor.js"

export const MAX_CHILD_AGE = 17
export const MAX_CHILDREN = 10
export type AgeMode = "all" | "any"

const integerString = z.string().regex(/^\d+$/)
const discoveryRange = z.enum(["today", "weekend", "upcoming"])
const querySchema = z.strictObject({
  city_id: z.uuid().optional(),
  keyword: z.string().trim().min(1).max(100).optional(), // legacy events-api capped keyword at 100
  range: discoveryRange.optional(),
  date_from: z.iso.datetime({ offset: true }).optional(),
  date_to: z.iso.datetime({ offset: true }).optional(),
  is_free: z.enum(["true", "false"]).optional(),
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

export interface ExploreQuery {
  cityId: string | null
  keyword: string | null
  range: DiscoveryRange | null
  dateFrom: string | null
  dateTo: string | null
  isFree: boolean | null
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
  const usesExplicitDates = result.data.date_from !== undefined || result.data.date_to !== undefined

  return {
    cityId: result.data.city_id ?? null,
    keyword: result.data.keyword ?? null,
    range: usesExplicitDates ? null : (result.data.range ?? "weekend"),
    dateFrom: result.data.date_from ?? null,
    dateTo: result.data.date_to ?? null,
    isFree: result.data.is_free === undefined ? null : result.data.is_free === "true",
    cost: result.data.cost ?? "any",
    after: result.data.cursor === undefined ? null : decodeCursor(result.data.cursor),
    limit,
    ...ageQuery,
    ...parseFamilyNeeds(result.data),
  }
}

const planQuerySchema = z.strictObject({
  city_id: z.uuid().optional(),
  kid_age: integerString.optional(),
})

const mapQuerySchema = z.strictObject({
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

export interface MapQuery extends AgeQuery {
  cityId: string | null
  range: DiscoveryRange
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
    range: result.data.range ?? "weekend",
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
