import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"

import type { CommunityEventInput, PreferredCity } from "../data/types.js"

export class ToggleInputDto {
  @ApiProperty()
  on!: boolean
}

export class RatingInputDto {
  @ApiProperty({ type: "integer", minimum: 1, maximum: 5 })
  score!: number
}

export class CommentInputDto {
  @ApiProperty({ minLength: 1, maxLength: 4000 })
  body!: string
}

export class CommunityEventInputDto implements CommunityEventInput {
  @ApiProperty({ minLength: 1 })
  title!: string

  @ApiPropertyOptional({ type: String, nullable: true })
  description?: string | null

  @ApiProperty({ format: "date-time" })
  startDatetime!: string

  @ApiPropertyOptional({ type: String, format: "date-time", nullable: true })
  endDatetime?: string | null

  @ApiPropertyOptional({ type: String, nullable: true })
  venueName?: string | null

  @ApiPropertyOptional({ type: String, nullable: true })
  address?: string | null

  @ApiProperty({ format: "uuid" })
  cityId!: string

  @ApiPropertyOptional({ type: "integer", minimum: 0, nullable: true })
  ageMin?: number | null

  @ApiPropertyOptional({ type: "integer", minimum: 0, nullable: true })
  ageMax?: number | null

  @ApiPropertyOptional({ default: true })
  isFree?: boolean

  @ApiPropertyOptional({ type: "number", minimum: 0, nullable: true })
  price?: number | null
}

export class PreferredCitiesInputDto {
  @ApiProperty({ type: [String], format: "uuid", minItems: 1 })
  city_ids!: string[]

  @ApiProperty({ format: "uuid" })
  primary_city_id!: string
}

export class OkResponseDto {
  @ApiProperty({ enum: [true] })
  ok!: true
}

export class RatingResponseDto {
  @ApiProperty({ type: "integer", minimum: 1, maximum: 5 })
  score!: number
}

export class IdResponseDto {
  @ApiProperty({ format: "uuid" })
  id!: string
}

export class RemovedResponseDto {
  @ApiProperty()
  removed!: boolean
}

export class PreferredCityDto implements PreferredCity {
  @ApiProperty({ format: "uuid" })
  user_id!: string

  @ApiProperty({ format: "uuid" })
  city_id!: string

  @ApiProperty()
  is_primary!: boolean

  @ApiProperty({ format: "date-time" })
  created_at!: string
}
