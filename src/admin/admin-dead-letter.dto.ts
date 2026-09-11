import { ApiProperty } from "@nestjs/swagger"

export class AdminDeadLetterDto {
  @ApiProperty({ enum: ["source", "tag"] })
  queue!: "source" | "tag"
  @ApiProperty({ type: String, pattern: "^[1-9]\\d*$", example: "9007199254740993" })
  id!: string
  @ApiProperty({ type: "integer", minimum: 0 })
  attempt_count!: number
  @ApiProperty({ type: String })
  enqueued_at!: string
  @ApiProperty({ type: String, nullable: true })
  started_at!: string | null
  @ApiProperty({ type: String, nullable: true })
  finished_at!: string | null
  @ApiProperty({ type: String })
  next_attempt_at!: string
  @ApiProperty({ type: String, nullable: true, maxLength: 1000 })
  last_error!: string | null
  @ApiProperty()
  trigger_type!: string
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  source_id!: string | null
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  source_run_id!: string | null
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  event_id!: string | null
}

export class AdminDeadLettersPageDto {
  @ApiProperty({ type: [AdminDeadLetterDto] })
  items!: AdminDeadLetterDto[]
  @ApiProperty({ type: String, nullable: true, description: "Opaque canonical base64url cursor" })
  next_cursor!: string | null
}

export class AdminDeadLetterRetryDto {
  @ApiProperty({ enum: ["queued", "already_active"] })
  status!: "queued" | "already_active"
  @ApiProperty({ type: String, pattern: "^[1-9]\\d*$" })
  resulting_queue_id!: string
}

export class AdminDeadLetterDeleteDto {
  @ApiProperty({ example: true })
  ok!: true
}
