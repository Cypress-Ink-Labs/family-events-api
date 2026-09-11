import { ApiProperty } from "@nestjs/swagger"

const COUNT = { type: "integer" as const, minimum: 0, maximum: Number.MAX_SAFE_INTEGER }

export class AdminConfidenceStatsDto {
  @ApiProperty(COUNT) high!: number
  @ApiProperty(COUNT) medium!: number
  @ApiProperty(COUNT) low!: number
}

export class AdminSourceStatsDto {
  @ApiProperty(COUNT) active!: number
  @ApiProperty(COUNT) errors!: number
}

export class AdminDeadLetterStatsDto {
  @ApiProperty(COUNT) tag_queue!: number
  @ApiProperty(COUNT) source_queue!: number
  @ApiProperty({ type: String, nullable: true }) oldest_tag_dead_at!: string | null
  @ApiProperty({ type: String, nullable: true }) oldest_source_dead_at!: string | null
}

export class AdminDashboardStatsDto {
  @ApiProperty(COUNT) total_events!: number
  @ApiProperty(COUNT) draft_events!: number
  @ApiProperty(COUNT) published_events!: number
  @ApiProperty({ type: AdminConfidenceStatsDto }) ai_confidence!: AdminConfidenceStatsDto
  @ApiProperty({ type: AdminSourceStatsDto }) sources!: AdminSourceStatsDto
  @ApiProperty({ type: AdminDeadLetterStatsDto }) dead_letters!: AdminDeadLetterStatsDto
  @ApiProperty({
    type: String,
    description:
      "Raw timestamp string preserving PostgreSQL microsecond precision; pass it unchanged.",
  })
  generated_at!: string
}

export class AdminTopRejectionSourceDto {
  @ApiProperty({ format: "uuid" }) source_id!: string
  @ApiProperty({ type: String, nullable: true }) source_name!: string | null
  @ApiProperty(COUNT) total!: number
  @ApiProperty(COUNT) rejected!: number
  @ApiProperty({ type: "number", minimum: 0, maximum: 100 }) rejection_rate!: number
}

export class AdminPipelineStatsDto {
  @ApiProperty({ type: "integer", minimum: 1, maximum: 365 }) window_days!: number
  @ApiProperty(COUNT) total_reviewed!: number
  @ApiProperty(COUNT) llm_reviewed!: number
  @ApiProperty(COUNT) admin_reviewed!: number
  @ApiProperty(COUNT) auto_rejected!: number
  @ApiProperty(COUNT) memory_hits!: number
  @ApiProperty(COUNT) total_embeddings!: number
  @ApiProperty(COUNT) tag_memory_hits!: number
  @ApiProperty({ type: [AdminTopRejectionSourceDto], maxItems: 10 })
  top_rejection_sources!: AdminTopRejectionSourceDto[]
  @ApiProperty({
    type: "object",
    additionalProperties: { type: "boolean" },
    description: "Feature flags exactly as returned by pipeline_learning_stats.",
  })
  feature_flags!: Record<string, boolean>
}
