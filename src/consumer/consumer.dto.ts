import { ApiProperty, ApiPropertyOptional, type ApiPropertyOptions } from "@nestjs/swagger"

import type { City, EnrichedEvent, PlannedEvent, Tag } from "../data/types.js"
import type { Json } from "../db/json.js"

const JSON_VALUE_PROPERTY: ApiPropertyOptions = {
  oneOf: [
    { type: "object", additionalProperties: true },
    { type: "array", items: {} },
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
  ],
  nullable: true,
}

export class EnrichedEventDto implements EnrichedEvent {
  @ApiProperty({ format: "uuid" })
  id!: string

  @ApiProperty()
  title!: string

  @ApiProperty({ type: String, nullable: true })
  description!: string | null

  @ApiProperty({ format: "date-time" })
  start_datetime!: string

  @ApiProperty({ type: String, format: "date-time", nullable: true })
  end_datetime!: string | null

  @ApiProperty({ type: String, nullable: true })
  timezone!: string | null

  @ApiProperty({ type: String, nullable: true })
  venue_name!: string | null

  @ApiProperty({ type: String, nullable: true })
  address!: string | null

  @ApiProperty({ type: String, format: "uuid", nullable: true })
  city_id!: string | null

  @ApiProperty({ type: String, nullable: true })
  latitude!: string | null

  @ApiProperty({ type: String, nullable: true })
  longitude!: string | null

  @ApiProperty({ type: "integer", nullable: true })
  age_min!: number | null

  @ApiProperty({ type: "integer", nullable: true })
  age_max!: number | null

  @ApiProperty({ type: String, nullable: true })
  price!: string | null

  @ApiProperty()
  is_free!: boolean

  @ApiProperty({ type: String, nullable: true })
  source_url!: string | null

  @ApiProperty({ type: String, nullable: true })
  source_name!: string | null

  @ApiProperty(JSON_VALUE_PROPERTY)
  images!: Json

  @ApiProperty()
  status!: string

  @ApiProperty(JSON_VALUE_PROPERTY)
  recurrence_info!: Json

  @ApiProperty()
  is_featured!: boolean

  @ApiProperty({ type: "integer" })
  view_count!: number

  @ApiProperty({ format: "date-time" })
  created_at!: string

  @ApiProperty({ format: "date-time" })
  updated_at!: string

  @ApiProperty({ type: String, nullable: true })
  avg_rating!: string | null

  @ApiProperty({ type: "integer" })
  rating_count!: number

  @ApiProperty(JSON_VALUE_PROPERTY)
  tags!: Json

  @ApiProperty()
  is_favorited!: boolean

  @ApiProperty()
  is_in_calendar!: boolean
}

export class CityDto implements City {
  @ApiProperty({ format: "uuid" })
  id!: string

  @ApiProperty()
  name!: string

  @ApiProperty({ type: String, nullable: true })
  state!: string | null

  @ApiProperty()
  slug!: string

  @ApiProperty()
  timezone!: string

  @ApiProperty({ type: String, nullable: true })
  latitude!: string | null

  @ApiProperty({ type: String, nullable: true })
  longitude!: string | null
}

export class TagDto implements Tag {
  @ApiProperty({ format: "uuid" })
  id!: string

  @ApiProperty()
  name!: string

  @ApiProperty()
  slug!: string

  @ApiProperty()
  color!: string
}

export class EventsPageDto {
  @ApiProperty({ type: [EnrichedEventDto] })
  events!: EnrichedEventDto[]

  @ApiProperty({ type: String, nullable: true })
  next_cursor!: string | null
}

export class PlannedEventDto implements PlannedEvent {
  @ApiProperty({ format: "uuid" })
  event_id!: string

  @ApiProperty()
  score!: string

  @ApiProperty({ format: "date-time" })
  start_datetime!: string

  @ApiProperty({ type: String, format: "uuid", nullable: true })
  city_id!: string | null

  @ApiProperty()
  title!: string

  @ApiProperty({ type: String, nullable: true })
  venue_name!: string | null

  @ApiProperty({ type: String, nullable: true })
  address!: string | null

  @ApiProperty()
  is_free!: boolean

  @ApiProperty({ type: String, nullable: true })
  price!: string | null

  @ApiProperty(JSON_VALUE_PROPERTY)
  images!: Json
}

export class PlanResponseDto {
  @ApiProperty()
  available!: boolean

  @ApiProperty({ type: [PlannedEventDto] })
  planned!: PlannedEventDto[]
}

export class PlanQueryDto {
  @ApiPropertyOptional({ format: "uuid" })
  city_id?: string

  @ApiPropertyOptional({ type: "integer", minimum: 0 })
  kid_age?: number
}

export class EventsQueryDto {
  @ApiPropertyOptional({ format: "uuid" })
  city_id?: string

  @ApiPropertyOptional()
  keyword?: string

  @ApiPropertyOptional({ format: "date-time" })
  date_from?: string

  @ApiPropertyOptional({ format: "date-time" })
  date_to?: string

  @ApiPropertyOptional()
  is_free?: boolean

  @ApiPropertyOptional({ type: "integer", minimum: 0 })
  kid_age?: number

  @ApiPropertyOptional({ description: "Base64 keyset cursor returned by the previous page" })
  cursor?: string

  @ApiPropertyOptional({ type: "integer", minimum: 1, maximum: 100, default: 24 })
  limit?: number
}
