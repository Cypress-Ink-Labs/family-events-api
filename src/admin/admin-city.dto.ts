import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"

export class AdminCityDto {
  @ApiProperty({ format: "uuid" }) id!: string
  @ApiProperty() name!: string
  @ApiProperty({ type: String, nullable: true }) state!: string | null
  @ApiProperty() country!: string
  @ApiProperty() slug!: string
  @ApiProperty() timezone!: string
  @ApiProperty({ type: String, nullable: true }) latitude!: string | null
  @ApiProperty({ type: String, nullable: true }) longitude!: string | null
  @ApiProperty() is_active!: boolean
  @ApiProperty({ format: "date-time" }) created_at!: string
}
export class AdminCreateCityDto {
  @ApiProperty() name!: string
  @ApiPropertyOptional({ type: String, nullable: true }) state?: string | null
  @ApiPropertyOptional({ default: "US" }) country?: string
  @ApiProperty() slug!: string
  @ApiProperty({ example: "America/New_York" }) timezone!: string
}
export class AdminCityActiveDto {
  @ApiProperty() is_active!: boolean
}
