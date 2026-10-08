import { ApiProperty } from "@nestjs/swagger"
export class AdminSourceRunDto {
  @ApiProperty({ format: "uuid" }) id!: string
  @ApiProperty({ type: String, format: "uuid", nullable: true }) source_id!: string | null
  @ApiProperty({ type: String, nullable: true }) source_name!: string | null
  @ApiProperty() started_at!: string
  @ApiProperty({ type: String, nullable: true }) completed_at!: string | null
  @ApiProperty({ enum: ["running", "success", "error", "partial"] }) status!: string
  @ApiProperty({ type: "integer" }) events_found!: number
  @ApiProperty({ type: "integer" }) events_imported!: number
  @ApiProperty({ type: "integer" }) events_skipped!: number
  @ApiProperty({ type: String, nullable: true }) error_log!: string | null
  @ApiProperty() created_at!: string
}
export class AdminSourceRunCursorDto {
  @ApiProperty({ description: "Raw PostgreSQL timestamp; pass unchanged to preserve microseconds" })
  after_started_at!: string
  @ApiProperty({ format: "uuid" }) after_id!: string
}
export class AdminSourceRunsPageDto {
  @ApiProperty({ type: [AdminSourceRunDto] }) runs!: AdminSourceRunDto[]
  @ApiProperty({ type: "integer" }) total_count!: number
  @ApiProperty({ type: AdminSourceRunCursorDto, nullable: true })
  next_cursor!: AdminSourceRunCursorDto | null
}
export class AdminSourceExtractionTraceDto {
  @ApiProperty({ description: "Exact PostgreSQL bigint string" }) id!: string
  @ApiProperty({ type: String, nullable: true }) source_queue_id!: string | null
  @ApiProperty() extraction_mode!: string
  @ApiProperty() extractor!: string
  @ApiProperty({ type: String, nullable: true }) provider!: string | null
  @ApiProperty({ type: String, nullable: true }) model!: string | null
  @ApiProperty() status!: string
  @ApiProperty({ type: "integer", nullable: true }) input_bytes!: number | null
  @ApiProperty({ type: "integer" }) parsed_event_count!: number
  @ApiProperty({ type: String, nullable: true }) fallback_reason!: string | null
  @ApiProperty({ type: "integer", nullable: true }) latency_ms!: number | null
  @ApiProperty({ type: String, nullable: true }) reasoning_summary!: string | null
  @ApiProperty({ type: String, nullable: true }) error!: string | null
  @ApiProperty() created_at!: string
}
export class AdminSourceRunDetailDto {
  @ApiProperty({ type: AdminSourceRunDto }) run!: AdminSourceRunDto
  @ApiProperty({
    type: [AdminSourceExtractionTraceDto],
    description: "Latest 200 extraction traces, newest first",
  })
  traces!: AdminSourceExtractionTraceDto[]
}
export class AdminActiveQueueDto {
  @ApiProperty({ description: "Exact PostgreSQL bigint string" }) id!: string
  @ApiProperty({ type: String, nullable: true }) entity_id!: string | null
  @ApiProperty({ type: String, nullable: true }) entity_name!: string | null
  @ApiProperty({ type: String, nullable: true }) source_id!: string | null
  @ApiProperty({ type: String, nullable: true }) source_run_id!: string | null
  @ApiProperty() status!: string
  @ApiProperty() trigger_type!: string
  @ApiProperty({ type: "integer" }) attempt_count!: number
  @ApiProperty() enqueued_at!: string
  @ApiProperty() next_attempt_at!: string
  @ApiProperty({ type: String, nullable: true }) started_at!: string | null
  @ApiProperty({ type: String, nullable: true }) last_error!: string | null
}
export class AdminQueueSummaryDto {
  @ApiProperty() status!: string
  @ApiProperty({ type: "integer" }) row_count!: number
  @ApiProperty({ type: String, nullable: true }) oldest_enqueued_at!: string | null
  @ApiProperty({ type: String, nullable: true }) newest_enqueued_at!: string | null
  @ApiProperty({ type: String, nullable: true }) oldest_processing_started_at!: string | null
  @ApiProperty({ type: String, nullable: true }) newest_finished_at!: string | null
  @ApiProperty({ type: String, nullable: true }) last_dead_letter_at!: string | null
  @ApiProperty({ description: "Exact PostgreSQL numeric string" }) avg_attempts!: string
}
export class AdminActiveQueuePageDto {
  @ApiProperty({ type: [AdminActiveQueueDto] }) rows!: AdminActiveQueueDto[]
  @ApiProperty({ type: [AdminQueueSummaryDto] }) summary!: AdminQueueSummaryDto[]
  @ApiProperty({ type: "integer" }) total_count!: number
  @ApiProperty({ type: String, nullable: true }) next_cursor!: string | null
}
