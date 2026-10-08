import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"

export class AdminRatingDto {
  @ApiProperty({ format: "uuid" }) id!: string
  @ApiProperty({ format: "uuid" }) user_id!: string
  @ApiProperty({ format: "uuid" }) event_id!: string
  @ApiProperty({ type: String, nullable: true }) display_name!: string | null
  @ApiProperty() event_title!: string
  @ApiProperty({ format: "date-time" }) created_at!: string
  @ApiProperty() score!: number
}
export class AdminCommentDto {
  @ApiProperty({ format: "uuid" }) id!: string
  @ApiProperty({ format: "uuid" }) user_id!: string
  @ApiProperty({ format: "uuid" }) event_id!: string
  @ApiProperty({ type: String, nullable: true }) display_name!: string | null
  @ApiProperty() event_title!: string
  @ApiProperty({ format: "date-time" }) created_at!: string
  @ApiProperty({ format: "date-time" }) updated_at!: string
  @ApiProperty() body!: string
  @ApiProperty() is_approved!: boolean
  @ApiProperty() is_flagged!: boolean
}
export class AdminCommentPageDto {
  @ApiProperty({ type: [AdminCommentDto] }) rows!: AdminCommentDto[]
  @ApiProperty() totalCount!: number
}
export class AdminRatingPageDto {
  @ApiProperty({ type: [AdminRatingDto] }) rows!: AdminRatingDto[]
  @ApiProperty() totalCount!: number
}
export class AdminCommentUpdateDto {
  @ApiPropertyOptional({ maxLength: 4000, minLength: 1 }) body?: string
  @ApiPropertyOptional() is_approved?: boolean
  @ApiPropertyOptional() is_flagged?: boolean
}
