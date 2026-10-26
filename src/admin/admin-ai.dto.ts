import { ApiProperty } from "@nestjs/swagger"

import { AI_CALL_FEATURES, AI_FAILURE_REASONS } from "../pipeline/ai-health.js"
import { AI_HEALTH_STATUSES } from "./ai-health-summary.js"

export class AdminAiModelDto {
  @ApiProperty() id!: string
  @ApiProperty({ enum: ["gateway", "openai", "ollama", "localai"] }) provider!: string
  @ApiProperty() display_name!: string
  @ApiProperty() description!: string
  @ApiProperty({ enum: ["low", "medium", "high"] }) cost_tier!: string
}
export class AdminAiFeatureDto {
  @ApiProperty() feature!: string
  @ApiProperty() model_id!: string
  @ApiProperty() enabled!: boolean
  @ApiProperty({ format: "date-time" }) updated_at!: string
  @ApiProperty({ type: String, nullable: true, format: "uuid" }) updated_by!: string | null
}
export class AdminAiSettingsDto {
  @ApiProperty({ type: [AdminAiModelDto] }) models!: AdminAiModelDto[]
  @ApiProperty({ type: [AdminAiFeatureDto] }) features!: AdminAiFeatureDto[]
}
export class AdminAiUpdateDto {
  @ApiProperty() model_id!: string
  @ApiProperty() enabled!: boolean
}
export class AdminPresenceDto {
  @ApiProperty({ format: "uuid" }) user_id!: string
  @ApiProperty() display_name!: string
}
export class AdminIngestionDayDto {
  @ApiProperty() day!: string
  @ApiProperty() imported!: number
  @ApiProperty() skipped!: number
  @ApiProperty() errors!: number
}
export class AdminRecentRunDto {
  @ApiProperty({ format: "uuid" }) id!: string
  @ApiProperty({ type: String, nullable: true }) source_name!: string | null
  @ApiProperty({ format: "date-time" }) started_at!: string
  @ApiProperty() status!: string
  @ApiProperty() events_imported!: number
  @ApiProperty() events_skipped!: number
}
export class AdminScheduleHealthDto {
  @ApiProperty() family!: string
  @ApiProperty() task!: string
  @ApiProperty({ type: String, nullable: true }) replaces!: string | null
  @ApiProperty({ type: Boolean, nullable: true }) legacy_enabled!: boolean | null
  @ApiProperty({ type: Boolean, nullable: true }) nest_enabled!: boolean | null
  @ApiProperty({ enum: ["legacy", "api", "paused", "internal"] }) owner!: string
}
export class AdminAiFeatureHealthDto {
  @ApiProperty() feature!: string
  @ApiProperty({ type: String, nullable: true }) provider!: string | null
  @ApiProperty() enabled!: boolean
  @ApiProperty({ description: "Whether the provider's key or URL is set; never the value." })
  credentials_configured!: boolean
}
export class AdminAiLastFailureDto {
  @ApiProperty({ enum: [...AI_CALL_FEATURES] }) feature!: string
  @ApiProperty() provider!: string
  @ApiProperty() model!: string
  @ApiProperty({ enum: [...AI_FAILURE_REASONS] }) reason!: string
  @ApiProperty({ format: "date-time" }) at!: string
}
export class AdminAiHealthDto {
  @ApiProperty({ enum: [...AI_HEALTH_STATUSES] }) status!: string
  @ApiProperty() gateway_key_configured!: boolean
  @ApiProperty({ type: [AdminAiFeatureHealthDto] }) features!: AdminAiFeatureHealthDto[]
  @ApiProperty({ type: AdminAiLastFailureDto, nullable: true })
  last_failure!: AdminAiLastFailureDto | null
  @ApiProperty({ type: String, nullable: true, format: "date-time" })
  last_success_at!: string | null
}
export class AdminDashboardHealthDto {
  @ApiProperty({ format: "date-time" }) generated_at!: string
  @ApiProperty({ type: [AdminPresenceDto] }) presence!: AdminPresenceDto[]
  @ApiProperty({ type: [AdminIngestionDayDto] }) ingestion!: AdminIngestionDayDto[]
  @ApiProperty({ type: [AdminRecentRunDto] }) recent_runs!: AdminRecentRunDto[]
  @ApiProperty({ type: [AdminScheduleHealthDto] }) schedules!: AdminScheduleHealthDto[]
  @ApiProperty({ type: AdminAiHealthDto }) ai!: AdminAiHealthDto
}
