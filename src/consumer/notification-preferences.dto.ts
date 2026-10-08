import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"

export class NotificationPreferencesDto {
  @ApiProperty() reminder_email!: boolean
  @ApiProperty() reminder_push!: boolean
  @ApiProperty() change_email!: boolean
  @ApiProperty() change_push!: boolean
  @ApiProperty() digest_email!: boolean
  @ApiProperty() digest_push!: boolean
}

export class NotificationDeliveryDto {
  @ApiProperty() email_configured!: boolean
  @ApiProperty() web_push_configured!: boolean
  @ApiProperty({ enum: [false] }) digest_push_supported!: false
  @ApiProperty() reminders_enabled!: boolean
  @ApiProperty() changes_enabled!: boolean
  @ApiProperty() digest_enabled!: boolean
  @ApiProperty({ type: String, nullable: true }) vapid_public_key!: string | null
}

export class BrowserSubscriptionDto {
  @ApiProperty({ format: "uuid" }) id!: string
  @ApiProperty({ format: "uri" }) endpoint!: string
}

export class NotificationSettingsDto {
  @ApiProperty({ type: NotificationPreferencesDto }) preferences!: NotificationPreferencesDto
  @ApiProperty({ type: NotificationDeliveryDto }) delivery!: NotificationDeliveryDto
  @ApiProperty({ type: [BrowserSubscriptionDto] }) subscriptions!: BrowserSubscriptionDto[]
}

export class NotificationPreferencesUpdateDto {
  @ApiPropertyOptional() reminder_email?: boolean
  @ApiPropertyOptional() reminder_push?: boolean
  @ApiPropertyOptional() change_email?: boolean
  @ApiPropertyOptional() change_push?: boolean
  @ApiPropertyOptional() digest_email?: boolean
  @ApiPropertyOptional() digest_push?: boolean
  @ApiPropertyOptional({
    format: "uuid",
    description: "Owned browser registration required when enabling reminder or change push",
  })
  browser_subscription_id?: string
}

export class BrowserSubscriptionInputDto {
  @ApiProperty({ format: "uri" }) endpoint!: string
  @ApiProperty() p256dh!: string
  @ApiProperty() auth_key!: string
}
