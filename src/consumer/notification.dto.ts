import { ApiProperty } from "@nestjs/swagger"

export class UserNotificationDto {
  @ApiProperty({ format: "uuid" }) id!: string
  @ApiProperty({ enum: ["reminder", "change", "digest", "system"] }) type!: string
  @ApiProperty() title!: string
  @ApiProperty() body!: string
  @ApiProperty({ type: String, format: "uuid", nullable: true }) event_id!: string | null
  @ApiProperty({ type: String, format: "date-time", nullable: true }) read_at!: string | null
  @ApiProperty({ format: "date-time" }) created_at!: string
}

export class NotificationInboxDto {
  @ApiProperty({ type: [UserNotificationDto], maxItems: 20 }) items!: UserNotificationDto[]
  @ApiProperty({ minimum: 0 }) unread_count!: number
}
