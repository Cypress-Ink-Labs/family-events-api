import { ApiProperty } from "@nestjs/swagger"
import { AdminEventDto } from "./admin-review.dto.js"

export class AdminReviewDetailsDto extends AdminEventDto {
  @ApiProperty({ type: String, nullable: true })
  ai_tag_provider!: string | null
  @ApiProperty({ type: String, nullable: true })
  ai_tag_model!: string | null
  @ApiProperty({ type: String, nullable: true })
  ai_tag_status!: string | null
  @ApiProperty({ type: String, nullable: true, description: "Exact PostgreSQL numeric string" })
  llm_review_confidence!: string | null
  @ApiProperty({ type: [String] })
  llm_review_flags!: string[]
  @ApiProperty({ type: String, nullable: true })
  llm_review_provider!: string | null
  @ApiProperty({ type: String, nullable: true })
  llm_review_model!: string | null
  @ApiProperty({ type: String, nullable: true })
  llm_review_prompt_version!: string | null
  @ApiProperty({
    type: String,
    nullable: true,
    description: "Raw PostgreSQL timestamp preserving microseconds",
  })
  llm_reviewed_at!: string | null
  @ApiProperty({ type: [String] })
  admin_locked_fields!: string[]
  @ApiProperty({ type: String, nullable: true })
  admin_last_edited_at!: string | null
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  admin_last_edited_by!: string | null
}

const JSON_VALUE = {
  oneOf: [
    { type: "object" as const, additionalProperties: true },
    { type: "array" as const, items: {} },
    { type: "string" as const },
    { type: "number" as const },
    { type: "boolean" as const },
    { type: "object" as const, nullable: true, enum: [null] },
  ],
}
export class AdminAiTraceDto {
  @ApiProperty({ format: "uuid" })
  id!: string
  @ApiProperty({ format: "uuid" })
  event_id!: string
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  source_run_id!: string | null
  @ApiProperty()
  trigger_type!: string
  @ApiProperty({ type: String, nullable: true })
  provider!: string | null
  @ApiProperty({ type: String, nullable: true })
  model!: string | null
  @ApiProperty()
  status!: string
  @ApiProperty()
  input_title!: string
  @ApiProperty({ type: String, nullable: true })
  input_description!: string | null
  @ApiProperty(JSON_VALUE)
  available_tag_slugs!: unknown
  @ApiProperty(JSON_VALUE)
  predicted_tags!: unknown
  @ApiProperty(JSON_VALUE)
  predicted_fields!: unknown
  @ApiProperty({ type: String, nullable: true })
  reasoning_summary!: string | null
  @ApiProperty({ type: String, nullable: true })
  fallback_reason!: string | null
  @ApiProperty({ type: "integer", nullable: true })
  processing_ms!: number | null
  @ApiProperty({ type: String, nullable: true })
  prompt_version!: string | null
  @ApiProperty({ description: "Raw PostgreSQL timestamp preserving microseconds" })
  created_at!: string
}
export class AdminEventDiagnosticsDto {
  @ApiProperty({ type: AdminReviewDetailsDto })
  review!: AdminReviewDetailsDto
  @ApiProperty({ type: AdminAiTraceDto, nullable: true })
  trace!: AdminAiTraceDto | null
}
