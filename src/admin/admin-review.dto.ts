import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"

import {
  ADMIN_STATUSES,
  LLM_REVIEW_DECISIONS,
  LLM_REVIEW_STATUSES,
  type AdminStatus,
  type LlmReviewDecision,
  type LlmReviewStatus,
} from "./admin-review.input.js"

export class AdminEventsQueryDto {
  @ApiPropertyOptional({ enum: ADMIN_STATUSES, enumName: "AdminStatus" })
  status?: AdminStatus

  @ApiPropertyOptional({ format: "uuid" })
  city_id?: string

  @ApiPropertyOptional({ type: Boolean })
  city_is_null?: boolean

  @ApiPropertyOptional({
    maxLength: 100,
    description: "Trimmed keyword; blank means no search filter",
  })
  keyword?: string

  @ApiPropertyOptional({
    format: "date-time",
    description:
      "Timezone required, up to six fractional digits. Must be paired with after_id; preserves the returned timestamp exactly.",
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
    description: "Trimmed keyword; blank means no search filter",
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

  @ApiProperty({ format: "date-time" })
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

  @ApiProperty({ type: String, enum: LLM_REVIEW_DECISIONS, nullable: true })
  llm_review_decision!: LlmReviewDecision | null

  @ApiProperty({ type: String, nullable: true })
  llm_review_reason!: string | null

  @ApiProperty({ type: String, nullable: true })
  llm_review_error!: string | null

  @ApiProperty({
    format: "date-time",
    description: "Timestamp preserved with microsecond precision",
  })
  created_at!: string
}

export class AdminEventsCursorDto {
  @ApiProperty({
    format: "date-time",
    description: "Pass back unchanged with after_id; preserves microsecond precision",
  })
  after_created_at!: string

  @ApiProperty({ format: "uuid" })
  after_id!: string
}

export class AdminEventsPageDto {
  @ApiProperty({ type: [AdminEventDto], maxItems: 500 })
  events!: AdminEventDto[]

  @ApiProperty({ type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
  total_count!: number

  @ApiProperty({
    type: AdminEventsCursorDto,
    nullable: true,
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

export class AdminStatusBodyDto {
  @ApiProperty({ enum: ADMIN_STATUSES })
  status!: AdminStatus

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 1000,
    description: "Trimmed; null, omitted, or blank becomes null. Overlong values are rejected.",
  })
  reason?: string | null
}

export class AdminBulkDeleteBodyDto {
  @ApiProperty({
    type: "array",
    items: { type: "string", format: "uuid" },
    minItems: 1,
    maxItems: 500,
    description: "Submit 1 to 500 UUIDs. Duplicates are removed after validation.",
  })
  event_ids!: string[]
}

export class AdminBulkStatusBodyDto extends AdminBulkDeleteBodyDto {
  @ApiProperty({ enum: ADMIN_STATUSES })
  status!: AdminStatus
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
