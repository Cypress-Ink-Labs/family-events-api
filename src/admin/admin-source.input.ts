import { BadRequestException, HttpStatus } from "@nestjs/common"
import { z } from "zod"

import { validateExternalUrl } from "../pipeline/ingestion/url-validation.js"

export const ADMIN_SOURCE_TYPES = [
  "website",
  "ical",
  "rss",
  "manual",
  "macaronikid",
  "brec",
  "downtownlafayette",
  "lcglafayette",
  "localhop",
] as const
export const ADMIN_EXTRACTION_MODES = ["deterministic", "llm", "deterministic_then_llm"] as const
export const ADMIN_PROCESSING_MODES = ["manual_review", "auto_approve", "llm_review"] as const
export const ADMIN_SOURCE_STATUSES = ["pending", "success", "error", "partial", "stale"] as const

export type AdminSourceType = (typeof ADMIN_SOURCE_TYPES)[number]
export type AdminExtractionMode = (typeof ADMIN_EXTRACTION_MODES)[number]
export type AdminProcessingMode = (typeof ADMIN_PROCESSING_MODES)[number]
export type AdminSourceStatus = (typeof ADMIN_SOURCE_STATUSES)[number]

const uuid = z.uuid().transform((value) => value.toLowerCase())
const sourceName = z.string().trim().min(1).max(300)
const sourceUrl = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .superRefine((value, context) => {
    const result = validateExternalUrl(value)
    if (!result.ok) {
      context.addIssue({ code: "custom", message: result.reason ?? "Invalid URL" })
    }
  })
const sourceType = z.enum(ADMIN_SOURCE_TYPES)
const extractionMode = z.enum(ADMIN_EXTRACTION_MODES)
const processingMode = z.enum(ADMIN_PROCESSING_MODES)
const cityId = uuid.nullable()
const scrapeIntervalHours = z.number().int().min(1).max(8760)
const notes = z.string().max(5000).nullable()
const dateWindowDays = z.number().int().min(1).max(365).nullable()

const createBody = z.strictObject({
  name: sourceName,
  url: sourceUrl,
  source_type: sourceType,
  extraction_mode: extractionMode,
  processing_mode: processingMode,
  city_id: cityId.optional().default(null),
  is_active: z.boolean().optional().default(true),
  scrape_interval_hours: scrapeIntervalHours.optional().default(24),
  notes: notes.optional().default(null),
  date_window_days: dateWindowDays.optional().default(null),
})

const updateBody = z
  .strictObject({
    name: sourceName.optional(),
    url: sourceUrl.optional(),
    source_type: sourceType.optional(),
    extraction_mode: extractionMode.optional(),
    city_id: cityId.optional(),
    is_active: z.boolean().optional(),
    scrape_interval_hours: scrapeIntervalHours.optional(),
    notes: notes.optional(),
    date_window_days: dateWindowDays.optional(),
  })
  .refine((input) => Object.keys(input).length > 0, {
    message: "must include at least one source field",
  })

const processingModeBody = z.strictObject({ mode: processingMode })
const emptyObject = z.strictObject({})
const emptyBody = z.union([z.undefined(), emptyObject])

export interface AdminCreateSourceInput {
  name: string
  url: string
  sourceType: AdminSourceType
  extractionMode: AdminExtractionMode
  processingMode: AdminProcessingMode
  cityId: string | null
  isActive: boolean
  scrapeIntervalHours: number
  notes: string | null
  dateWindowDays: number | null
}

export interface AdminSourcePatch {
  name?: string
  url?: string
  sourceType?: AdminSourceType
  extractionMode?: AdminExtractionMode
  cityId?: string | null
  isActive?: boolean
  scrapeIntervalHours?: number
  notes?: string | null
  dateWindowDays?: number | null
}

function parse<T>(
  schema: z.ZodType<T>,
  input: unknown,
  message: "invalid request body" | "invalid query parameters" | "invalid source id"
): T {
  const result = schema.safeParse(input)
  if (!result.success) {
    throw new BadRequestException({
      statusCode: HttpStatus.BAD_REQUEST,
      message,
      error: "Bad Request",
      issues: result.error.issues.map((issue) => {
        const path =
          issue.code === "unrecognized_keys" ? [...issue.path, issue.keys[0] ?? ""] : issue.path
        return {
          path: path.map(String).filter(Boolean).join("."),
          message: issue.message,
        }
      }),
    })
  }
  return result.data
}

export function parseAdminCreateSourceBody(body: unknown): AdminCreateSourceInput {
  const input = parse(createBody, body, "invalid request body")
  return {
    name: input.name,
    url: input.url,
    sourceType: input.source_type,
    extractionMode: input.extraction_mode,
    processingMode: input.processing_mode,
    cityId: input.city_id,
    isActive: input.is_active,
    scrapeIntervalHours: input.scrape_interval_hours,
    notes: input.notes,
    dateWindowDays: input.date_window_days,
  }
}

export function parseAdminUpdateSourceBody(body: unknown): AdminSourcePatch {
  const input = parse(updateBody, body, "invalid request body")
  return {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.url !== undefined ? { url: input.url } : {}),
    ...(input.source_type !== undefined ? { sourceType: input.source_type } : {}),
    ...(input.extraction_mode !== undefined ? { extractionMode: input.extraction_mode } : {}),
    ...(input.city_id !== undefined ? { cityId: input.city_id } : {}),
    ...(input.is_active !== undefined ? { isActive: input.is_active } : {}),
    ...(input.scrape_interval_hours !== undefined
      ? { scrapeIntervalHours: input.scrape_interval_hours }
      : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    ...(input.date_window_days !== undefined ? { dateWindowDays: input.date_window_days } : {}),
  }
}

export function parseAdminSourceProcessingModeBody(body: unknown): AdminProcessingMode {
  return parse(processingModeBody, body, "invalid request body").mode
}

export function parseAdminSourceId(id: unknown): string {
  return parse(uuid, id, "invalid source id")
}

export function parseAdminSourcesQuery(query: unknown): void {
  parse(emptyObject, query, "invalid query parameters")
}

export function parseAdminSourceScrapeBody(body: unknown): void {
  parse(emptyBody, body, "invalid request body")
}
