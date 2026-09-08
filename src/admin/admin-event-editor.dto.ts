import { ApiProperty, type ApiBodyOptions } from "@nestjs/swagger"

import { ADMIN_STATUSES, type AdminStatus } from "./admin-review.input.js"

const RAW_TIMESTAMP_DESCRIPTION =
  "Raw timestamp string preserving PostgreSQL microsecond precision; pass it unchanged when no edit is intended."

type RequestBodySchema = Extract<ApiBodyOptions, { schema: unknown }>["schema"]

const JSON_VALUE_SCHEMA: RequestBodySchema = {
  oneOf: [
    { type: "object", additionalProperties: true },
    { type: "array", items: {} },
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "object", nullable: true, enum: [null] },
  ],
}

export class AdminEditorTagDto {
  @ApiProperty({ format: "uuid" })
  id!: string

  @ApiProperty()
  name!: string

  @ApiProperty()
  slug!: string

  @ApiProperty()
  color!: string
}

export class AdminEventTagDto extends AdminEditorTagDto {
  @ApiProperty({
    type: String,
    description: "Exact PostgreSQL numeric string preserving decimal precision",
  })
  confidence!: string

  @ApiProperty()
  is_manual_override!: boolean
}

export class AdminEditableEventDto {
  @ApiProperty({ format: "uuid" })
  id!: string

  @ApiProperty({ minLength: 1, maxLength: 500 })
  title!: string

  @ApiProperty({ type: String, nullable: true, maxLength: 10_000 })
  description!: string | null

  @ApiProperty({ type: String, description: RAW_TIMESTAMP_DESCRIPTION })
  start_datetime!: string

  @ApiProperty({ type: String, nullable: true, description: RAW_TIMESTAMP_DESCRIPTION })
  end_datetime!: string | null

  @ApiProperty({ maxLength: 100 })
  timezone!: string

  @ApiProperty({ type: String, nullable: true, maxLength: 300 })
  venue_name!: string | null

  @ApiProperty({ type: String, nullable: true, maxLength: 500 })
  address!: string | null

  @ApiProperty({ type: String, format: "uuid", nullable: true })
  city_id!: string | null

  @ApiProperty({ type: String, nullable: true, description: "Exact PostgreSQL numeric string" })
  latitude!: string | null

  @ApiProperty({ type: String, nullable: true, description: "Exact PostgreSQL numeric string" })
  longitude!: string | null

  @ApiProperty({ type: "integer", minimum: 0, nullable: true })
  age_min!: number | null

  @ApiProperty({ type: "integer", minimum: 0, nullable: true })
  age_max!: number | null

  @ApiProperty({ type: String, nullable: true, description: "Exact PostgreSQL numeric string" })
  price!: string | null

  @ApiProperty()
  is_free!: boolean

  @ApiProperty({ type: Boolean, nullable: true })
  is_outdoor!: boolean | null

  @ApiProperty({ type: String, nullable: true, maxLength: 2048 })
  source_url!: string | null

  @ApiProperty({ type: String, nullable: true, maxLength: 300 })
  source_name!: string | null

  @ApiProperty({ type: String, format: "uuid", nullable: true })
  source_id!: string | null

  @ApiProperty({ type: [String], maxItems: 20 })
  images!: string[]

  @ApiProperty({ enum: ADMIN_STATUSES })
  status!: AdminStatus

  @ApiProperty({
    oneOf: [
      { type: "object", additionalProperties: true },
      { type: "array", items: {} },
      { type: "string" },
      { type: "number" },
      { type: "boolean" },
      { type: "object", nullable: true, enum: [null] },
    ],
  })
  recurrence_info!: unknown

  @ApiProperty()
  is_featured!: boolean

  @ApiProperty({ type: [String] })
  admin_locked_fields!: string[]

  @ApiProperty({ type: String, nullable: true, description: RAW_TIMESTAMP_DESCRIPTION })
  admin_last_edited_at!: string | null

  @ApiProperty({ type: String, format: "uuid", nullable: true })
  admin_last_edited_by!: string | null

  @ApiProperty({ type: String, description: RAW_TIMESTAMP_DESCRIPTION })
  created_at!: string

  @ApiProperty({ type: String, description: RAW_TIMESTAMP_DESCRIPTION })
  updated_at!: string
}

export class AdminEventEditorDetailDto {
  @ApiProperty({ type: AdminEditableEventDto })
  event!: AdminEditableEventDto

  @ApiProperty({ type: [AdminEventTagDto] })
  tags!: AdminEventTagDto[]

  @ApiProperty({ type: [AdminEditorTagDto] })
  available_tags!: AdminEditorTagDto[]
}

const NULLABLE_STRING = (maximum?: number): RequestBodySchema => ({
  type: "string",
  nullable: true,
  ...(maximum === undefined ? {} : { maxLength: maximum }),
})
const NULLABLE_UUID: RequestBodySchema = { type: "string", format: "uuid", nullable: true }
const NULLABLE_NUMBER = (minimum: number, maximum: number): RequestBodySchema => ({
  type: "number",
  nullable: true,
  minimum,
  maximum,
})

export const ADMIN_EVENT_UPDATE_BODY_SCHEMA: RequestBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["patch", "tag_ids"],
  properties: {
    patch: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", minLength: 1, maxLength: 500 },
        description: NULLABLE_STRING(10_000),
        start_datetime: { type: "string" },
        end_datetime: { type: "string", nullable: true },
        timezone: { type: "string", minLength: 1, maxLength: 100 },
        venue_name: NULLABLE_STRING(300),
        address: NULLABLE_STRING(500),
        city_id: NULLABLE_UUID,
        latitude: NULLABLE_NUMBER(-90, 90),
        longitude: NULLABLE_NUMBER(-180, 180),
        age_min: { type: "integer", minimum: 0, nullable: true },
        age_max: { type: "integer", minimum: 0, nullable: true },
        price: { type: "number", minimum: 0, maximum: 99_999_999.99, nullable: true },
        is_free: { type: "boolean" },
        is_outdoor: { type: "boolean", nullable: true },
        source_url: {
          type: "string",
          format: "uri",
          nullable: true,
          maxLength: 2048,
          description: "Must use the http or https protocol.",
        },
        source_name: NULLABLE_STRING(300),
        source_id: NULLABLE_UUID,
        images: {
          type: "array",
          items: {
            type: "string",
            format: "uri",
            maxLength: 2048,
            description: "Must use the http or https protocol.",
          },
          maxItems: 20,
        },
        status: { type: "string", enum: [...ADMIN_STATUSES] },
        recurrence_info: JSON_VALUE_SCHEMA,
        is_featured: { type: "boolean" },
      },
    },
    tag_ids: {
      type: "array",
      items: { type: "string", format: "uuid" },
      maxItems: 500,
      description: "Required explicit replacement set. An empty array removes every event tag.",
    },
    lock_edited_fields: {
      type: "boolean",
      default: true,
      description: "When true, fields present in patch are protected from later ingestion writes.",
    },
    decision_reason: {
      type: "string",
      nullable: true,
      maxLength: 1000,
      description: "Trimmed; null, omitted, or blank becomes null.",
    },
  },
}
