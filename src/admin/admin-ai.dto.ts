import { ApiProperty } from "@nestjs/swagger"

export class AdminAiModelDto {
  @ApiProperty() id!: string
  @ApiProperty({ enum: ["openai", "ollama", "localai"] }) provider!: string
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
export class AdminDashboardHealthDto {
  @ApiProperty({ format: "date-time" }) generated_at!: string
  @ApiProperty({ type: [AdminPresenceDto] }) presence!: AdminPresenceDto[]
  @ApiProperty({ type: [AdminIngestionDayDto] }) ingestion!: AdminIngestionDayDto[]
  @ApiProperty({ type: [AdminRecentRunDto] }) recent_runs!: AdminRecentRunDto[]
  @ApiProperty({ type: [AdminScheduleHealthDto] }) schedules!: AdminScheduleHealthDto[]
}
