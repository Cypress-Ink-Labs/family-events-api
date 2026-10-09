import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"

export class PublicEventDto {
  @ApiProperty({ format: "uuid" }) id!: string
  @ApiProperty() title!: string
  @ApiProperty({ type: String, nullable: true }) description!: string | null
  @ApiProperty({ format: "date-time" }) start_datetime!: string
  @ApiProperty({ type: String, nullable: true, format: "date-time" }) end_datetime!: string | null
  @ApiProperty({ type: String, nullable: true }) timezone!: string | null
  @ApiProperty({ type: String, nullable: true }) venue_name!: string | null
  @ApiProperty({ type: String, nullable: true }) address!: string | null
  @ApiProperty({ type: String, nullable: true, format: "uuid" }) city_id!: string | null
  @ApiProperty({ type: Number, nullable: true }) latitude!: number | null
  @ApiProperty({ type: Number, nullable: true }) longitude!: number | null
  @ApiProperty({ type: Number, nullable: true }) age_min!: number | null
  @ApiProperty({ type: Number, nullable: true }) age_max!: number | null
  @ApiProperty({ type: Number, nullable: true }) price!: number | null
  @ApiProperty() is_free!: boolean
  @ApiProperty() is_featured!: boolean
  @ApiProperty({ type: Boolean, nullable: true }) is_outdoor!: boolean | null
  @ApiProperty({ type: "array", items: {} }) images!: unknown[]
  @ApiProperty({ type: String, nullable: true }) source_url!: string | null
}

export class PublicEventsPageDto {
  @ApiProperty({ type: [PublicEventDto] }) data!: PublicEventDto[]
  @ApiPropertyOptional() next_cursor?: string
}
export class PublicEventEnvelopeDto {
  @ApiProperty({ type: PublicEventDto }) data!: PublicEventDto
}
export class SitemapEventDto {
  @ApiProperty({ format: "uuid" }) id!: string
  @ApiProperty({ format: "date-time" }) start_datetime!: string
}
export class PublicEventsQueryDto {
  @ApiPropertyOptional({ format: "uuid" }) city_id?: string
  @ApiPropertyOptional({ format: "date-time" }) date_from?: string
  @ApiPropertyOptional({ format: "date-time" }) date_to?: string
  @ApiPropertyOptional({ enum: ["true", "false"] }) is_free?: string
  @ApiPropertyOptional({ description: "Comma-separated tag slugs, maximum 10" }) tags?: string
  @ApiPropertyOptional({ maxLength: 100 }) keyword?: string
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 }) limit?: number
  @ApiPropertyOptional({ description: "Legacy Base64 JSON keyset cursor" }) cursor?: string
}
