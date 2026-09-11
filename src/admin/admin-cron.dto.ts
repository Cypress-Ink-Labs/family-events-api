import { ApiProperty } from "@nestjs/swagger"

export class AdminCronRunSummaryDto {
  @ApiProperty({ type: String, pattern: "^[1-9]\\d*$" }) id!: string
  @ApiProperty() label!: string
  @ApiProperty() status!: string
  @ApiProperty({ type: String }) ran_at!: string
  @ApiProperty({ type: "integer", nullable: true }) duration_s!: number | null
  @ApiProperty({ type: "integer", nullable: true }) http_status!: number | null
}

export class AdminCronScheduleDto {
  @ApiProperty() family!: string
  @ApiProperty() queue!: string
  @ApiProperty() task!: string
  @ApiProperty() cron!: string
  @ApiProperty({ type: String, nullable: true }) replaces!: string | null
  @ApiProperty({ type: Boolean, nullable: true }) legacy_enabled!: boolean | null
  @ApiProperty({ type: Boolean, nullable: true }) nest_enabled!: boolean | null
  @ApiProperty({ type: AdminCronRunSummaryDto, nullable: true })
  latest_run!: AdminCronRunSummaryDto | null
}

export class AdminCronSchedulesDto {
  @ApiProperty({ type: [AdminCronScheduleDto] }) items!: AdminCronScheduleDto[]
}

export class AdminCronRunsDto {
  @ApiProperty({ type: [AdminCronRunSummaryDto] }) items!: AdminCronRunSummaryDto[]
}

export class AdminCronLogDto {
  @ApiProperty({ type: String, pattern: "^[1-9]\\d*$" }) id!: string
  @ApiProperty({ enum: ["railway", "supabase"] }) provider!: "railway" | "supabase"
  @ApiProperty({ enum: ["debug", "info", "log", "warn", "error"] })
  level!: "debug" | "info" | "log" | "warn" | "error"
  @ApiProperty() message!: string
  @ApiProperty({ type: Object, additionalProperties: true }) metadata!: Record<string, unknown>
  @ApiProperty({ type: "integer", nullable: true }) sequence!: number | null
  @ApiProperty({ type: String }) created_at!: string
}

export class AdminCronRunDetailDto extends AdminCronRunSummaryDto {
  @ApiProperty({ format: "uuid" }) run_key!: string
  @ApiProperty({ type: String, nullable: true }) body!: string | null
  @ApiProperty({ type: [AdminCronLogDto] }) logs!: AdminCronLogDto[]
}
