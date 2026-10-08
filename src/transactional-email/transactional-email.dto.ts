import { ApiProperty } from "@nestjs/swagger"

export class InviteDeliveryDto {
  @ApiProperty({ format: "uuid" }) id!: string
  @ApiProperty({ enum: ["welcome", "admin_request", "request_approved", "request_rejected"] })
  kind!: string
  @ApiProperty({ type: String, format: "uuid", nullable: true }) target_id!: string | null
  @ApiProperty({ enum: ["pending", "processing", "sent", "failed", "needs_review", "cancelled"] })
  status!: string
  @ApiProperty({ type: "integer", minimum: 0 }) attempts!: number
  @ApiProperty({ type: String, format: "date-time" }) next_attempt_at!: string
  @ApiProperty({ type: String, format: "date-time", nullable: true }) first_attempt_at!:
    | string
    | null
  @ApiProperty({ type: String, format: "date-time", nullable: true }) sent_at!: string | null
  @ApiProperty({
    type: String,
    nullable: true,
    description: "Sanitized delivery category. Message contents are never returned.",
  })
  last_error!: string | null
  @ApiProperty({ type: String, format: "date-time" }) created_at!: string
  @ApiProperty({ type: String, format: "date-time" }) updated_at!: string
}
export class InviteDeliveryReadinessDto {
  @ApiProperty() worker_enabled!: boolean
  @ApiProperty() provider_configured!: boolean
  @ApiProperty() admin_recipient_configured!: boolean
}
