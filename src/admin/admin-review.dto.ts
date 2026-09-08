import {
  ApiExtraModels,
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
  type ApiBodyOptions,
} from "@nestjs/swagger"

import {
  ADMIN_STATUSES,
  LLM_REVIEW_DECISIONS,
  LLM_REVIEW_STATUSES,
  type AdminStatus,
  type LlmReviewDecision,
  type LlmReviewStatus,
} from "./admin-review.input.js"

const RAW_TIMESTAMP_DESCRIPTION =
  "Raw timestamp string, preserving up to six fractional digits. Accepts PostgreSQL and ISO representations: a space or T separates date and time; the required timezone is Z or a signed HH, HHMM, or HH:MM offset. Example: 2026-09-07 12:34:56.123456+00."

type RequestBodySchema = Extract<ApiBodyOptions, { schema: unknown }>["schema"]

export class AdminEventsQueryDto {
  @ApiPropertyOptional({ enum: ADMIN_STATUSES, enumName: "AdminStatus" })
  status?: AdminStatus

  @ApiPropertyOptional({ format: "uuid" })
  city_id?: string

  @ApiPropertyOptional({ type: Boolean })
  city_is_null?: boolean

  @ApiPropertyOptional({
    maxLength: 100,
    description: "Trimmed before the 100-character limit is checked; blank means no search filter",
  })
  keyword?: string

  @ApiPropertyOptional({
    type: String,
    description: `${RAW_TIMESTAMP_DESCRIPTION} Must be paired with after_id; pass the returned timestamp unchanged.`,
  })
  after_created_at?: string

  @ApiPropertyOptional({ format: "uuid", description: "Must be paired with after_created_at" })
  after_id?: string

  @ApiPropertyOptional({ type: "integer", minimum: 1, maximum: 500, default: 200 })
  limit?: number

  @ApiPropertyOptional({ enum: LLM_REVIEW_STATUSES, enumName: "LlmReviewStatus" })
  llm_review_status?: LlmReviewStatus

  @ApiPropertyOptional({ enum: LLM_REVIEW_DECISIONS, enumName: "LlmReviewDecision" })
  llm_review_decision?: LlmReviewDecision

  @ApiPropertyOptional({
    type: Boolean,
    description:
      "True requires a completed, nonfailed review with a decision. False leaves this filter inactive.",
  })
  llm_reviewed?: boolean

  @ApiPropertyOptional({ format: "uuid" })
  source_id?: string
}

export class AdminFacetsQueryDto {
  @ApiPropertyOptional({
    maxLength: 100,
    description: "Trimmed before the 100-character limit is checked; blank means no search filter",
  })
  keyword?: string
}

export class AdminEventDto {
  @ApiProperty({ format: "uuid" })
  id!: string

  @ApiProperty()
  title!: string

  @ApiProperty({ enum: ADMIN_STATUSES })
  status!: AdminStatus

  @ApiProperty({ type: String, description: RAW_TIMESTAMP_DESCRIPTION })
  start_datetime!: string

  @ApiProperty({ type: String, nullable: true })
  venue_name!: string | null

  @ApiProperty({ type: String, format: "uuid", nullable: true })
  city_id!: string | null

  @ApiProperty({ type: String, format: "uuid", nullable: true })
  source_id!: string | null

  @ApiProperty({ type: String, nullable: true })
  source_name!: string | null

  @ApiProperty()
  is_free!: boolean

  @ApiProperty({ type: "integer", nullable: true })
  age_min!: number | null

  @ApiProperty({ type: "integer", nullable: true })
  age_max!: number | null

  @ApiProperty({
    type: String,
    nullable: true,
    description: "Exact PostgreSQL numeric string, preserving decimal precision",
  })
  ai_confidence!: string | null

  @ApiProperty({ enum: LLM_REVIEW_STATUSES })
  llm_review_status!: LlmReviewStatus

  @ApiProperty({ type: String, enum: [...LLM_REVIEW_DECISIONS, null], nullable: true })
  llm_review_decision!: LlmReviewDecision | null

  @ApiProperty({ type: String, nullable: true })
  llm_review_reason!: string | null

  @ApiProperty({ type: String, nullable: true })
  llm_review_error!: string | null

  @ApiProperty({
    type: String,
    description: RAW_TIMESTAMP_DESCRIPTION,
  })
  created_at!: string
}

export class AdminEventsCursorDto {
  @ApiProperty({
    type: String,
    description: `${RAW_TIMESTAMP_DESCRIPTION} Pass back unchanged with after_id.`,
  })
  after_created_at!: string

  @ApiProperty({ format: "uuid" })
  after_id!: string
}

@ApiExtraModels(AdminEventsCursorDto)
export class AdminEventsPageDto {
  @ApiProperty({ type: [AdminEventDto], maxItems: 500 })
  events!: AdminEventDto[]

  @ApiProperty({ type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
  total_count!: number

  @ApiProperty({
    oneOf: [
      { $ref: getSchemaPath(AdminEventsCursorDto) },
      { type: "object", nullable: true, enum: [null] },
    ],
    description: "Present only when another matching row exists",
  })
  next_cursor!: AdminEventsCursorDto | null
}

export class AdminFacetDto {
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  city_id!: string | null

  @ApiProperty({ type: String, format: "uuid", nullable: true })
  source_id!: string | null

  @ApiProperty({ enum: ADMIN_STATUSES })
  status!: AdminStatus

  @ApiProperty({ type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
  count!: number
}

const EVENT_IDS_SCHEMA: RequestBodySchema = {
  type: "array",
  items: { type: "string", format: "uuid" },
  minItems: 1,
  maxItems: 500,
  description: "Submit 1 to 500 UUIDs. Duplicates are removed after validation.",
}

export const ADMIN_STATUS_BODY_SCHEMA: RequestBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: { type: "string", enum: [...ADMIN_STATUSES] },
    reason: {
      type: "string",
      nullable: true,
      maxLength: 1000,
      description: "Trimmed; null, omitted, or blank becomes null. Overlong values are rejected.",
    },
  },
}

export const ADMIN_BULK_STATUS_BODY_SCHEMA: RequestBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["event_ids", "status"],
  properties: {
    event_ids: EVENT_IDS_SCHEMA,
    status: { type: "string", enum: [...ADMIN_STATUSES] },
  },
}

export const ADMIN_BULK_DELETE_BODY_SCHEMA: RequestBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["event_ids"],
  properties: { event_ids: EVENT_IDS_SCHEMA },
}

export class AdminErrorDto {
  @ApiProperty({ type: "integer", enum: [401, 403, 404] })
  statusCode!: number

  @ApiProperty({ description: "Stable Nest error message" })
  message!: string

  @ApiPropertyOptional({ description: "Nest error name; omitted by the default 404 response" })
  error?: string
}

export class AdminValidationIssueDto {
  @ApiProperty({ description: "Dot-separated field path; empty for errors on the whole object" })
  path!: string

  @ApiProperty()
  message!: string
}

export class AdminValidationErrorDto {
  @ApiProperty({ type: "integer", enum: [400] })
  statusCode!: 400

  @ApiProperty({
    enum: [
      "invalid request body",
      "invalid query parameters",
      "invalid event id",
      "invalid source id",
    ],
  })
  message!: string

  @ApiProperty({ enum: ["Bad Request"] })
  error!: string

  @ApiProperty({ type: [AdminValidationIssueDto], minItems: 1 })
  issues!: AdminValidationIssueDto[]
}

export class AdminMutationResultDto {
  @ApiProperty({ type: Boolean, enum: [true] })
  ok!: true

  @ApiProperty({ type: "integer", minimum: 0, maximum: 500 })
  affected!: number
}

export class AdminStatusResultDto {
  @ApiProperty({ type: Boolean, enum: [true] })
  ok!: true

  @ApiProperty({ type: "integer", enum: [1], minimum: 1, maximum: 1 })
  affected!: 1
}
