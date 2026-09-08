import { ApiProperty, type ApiBodyOptions } from "@nestjs/swagger"

import {
  ADMIN_EXTRACTION_MODES,
  ADMIN_PROCESSING_MODES,
  ADMIN_SOURCE_STATUSES,
  ADMIN_SOURCE_TYPES,
  type AdminExtractionMode,
  type AdminProcessingMode,
  type AdminSourceStatus,
  type AdminSourceType,
} from "./admin-source.input.js"

const RAW_TIMESTAMP_DESCRIPTION =
  "Raw timestamp string preserving PostgreSQL microsecond precision; pass it unchanged."

type RequestBodySchema = Extract<ApiBodyOptions, { schema: unknown }>["schema"]

export class AdminSourceDto {
  @ApiProperty({ format: "uuid" })
  id!: string

  @ApiProperty({ minLength: 1, maxLength: 300 })
  name!: string

  @ApiProperty({ maxLength: 2048 })
  url!: string

  @ApiProperty({ enum: ADMIN_SOURCE_TYPES })
  source_type!: AdminSourceType

  @ApiProperty({ enum: ADMIN_EXTRACTION_MODES })
  extraction_mode!: AdminExtractionMode

  @ApiProperty({ enum: ADMIN_PROCESSING_MODES })
  processing_mode!: AdminProcessingMode

  @ApiProperty({ type: String, format: "uuid", nullable: true })
  city_id!: string | null

  @ApiProperty()
  is_active!: boolean

  @ApiProperty()
  auto_approve!: boolean

  @ApiProperty({ type: "integer", minimum: 1, maximum: 8760 })
  scrape_interval_hours!: number

  @ApiProperty({ type: String, nullable: true, description: RAW_TIMESTAMP_DESCRIPTION })
  last_scraped_at!: string | null

  @ApiProperty({ type: String, enum: [...ADMIN_SOURCE_STATUSES, null], nullable: true })
  last_status!: AdminSourceStatus | null

  @ApiProperty({ type: "integer", minimum: 0 })
  error_count!: number

  @ApiProperty({ type: String, nullable: true, maxLength: 5000 })
  notes!: string | null

  @ApiProperty({ type: "integer", minimum: 1, maximum: 365, nullable: true })
  date_window_days!: number | null

  @ApiProperty({ type: "integer", minimum: 0 })
  consecutive_zero_result_scrapes!: number

  @ApiProperty({ type: String, nullable: true, description: RAW_TIMESTAMP_DESCRIPTION })
  stale_escalated_at!: string | null

  @ApiProperty({ type: String, description: RAW_TIMESTAMP_DESCRIPTION })
  created_at!: string

  @ApiProperty({ type: String, description: RAW_TIMESTAMP_DESCRIPTION })
  updated_at!: string
}

export class AdminSourceScrapeResultDto {
  @ApiProperty({
    type: String,
    description: "Exact PostgreSQL bigint string identifying the durable queue row",
  })
  queue_id!: string

  @ApiProperty({
    description: "True when an active queue row already existed for this source",
  })
  deduped!: boolean
}

export class AdminSourceMutationResultDto {
  @ApiProperty({ type: Boolean, enum: [true] })
  ok!: true
}

const SOURCE_PROPERTIES: Record<string, RequestBodySchema> = {
  name: { type: "string", minLength: 1, maxLength: 300 },
  url: {
    type: "string",
    format: "uri",
    minLength: 1,
    maxLength: 2048,
    description: "Must be an externally routable HTTP or HTTPS URL.",
  },
  source_type: { type: "string", enum: [...ADMIN_SOURCE_TYPES] },
  extraction_mode: { type: "string", enum: [...ADMIN_EXTRACTION_MODES] },
  city_id: { type: "string", format: "uuid", nullable: true },
  is_active: { type: "boolean" },
  scrape_interval_hours: { type: "integer", minimum: 1, maximum: 8760 },
  notes: { type: "string", nullable: true, maxLength: 5000 },
  date_window_days: { type: "integer", nullable: true, minimum: 1, maximum: 365 },
}

export const ADMIN_CREATE_SOURCE_BODY_SCHEMA: RequestBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "url", "source_type", "extraction_mode", "processing_mode"],
  properties: {
    ...SOURCE_PROPERTIES,
    city_id: { ...SOURCE_PROPERTIES.city_id, default: null },
    is_active: { ...SOURCE_PROPERTIES.is_active, default: true },
    scrape_interval_hours: { ...SOURCE_PROPERTIES.scrape_interval_hours, default: 24 },
    notes: { ...SOURCE_PROPERTIES.notes, default: null },
    date_window_days: { ...SOURCE_PROPERTIES.date_window_days, default: null },
    processing_mode: { type: "string", enum: [...ADMIN_PROCESSING_MODES] },
  },
}

export const ADMIN_UPDATE_SOURCE_BODY_SCHEMA: RequestBodySchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: SOURCE_PROPERTIES,
}

export const ADMIN_SOURCE_PROCESSING_MODE_BODY_SCHEMA: RequestBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["mode"],
  properties: {
    mode: { type: "string", enum: [...ADMIN_PROCESSING_MODES] },
  },
}
