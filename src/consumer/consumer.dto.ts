import { ApiProperty, ApiPropertyOptional, type ApiPropertyOptions } from "@nestjs/swagger"

import type {
  CalendarEvent,
  City,
  EnrichedEvent,
  PlannedEvent,
  PublicEventComment,
  SimilarEvent,
  Tag,
} from "../data/types.js"
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

  @ApiProperty({ enum: ["free", "paid", "unknown"] })
  admission_cost_state!: "free" | "paid" | "unknown"

  @ApiProperty({ type: String, nullable: true, description: "Exact PostgreSQL numeric string" })
  admission_amount!: string | null

  @ApiProperty({ type: String, nullable: true })
  admission_cost_evidence!: string | null

  @ApiProperty({ type: String, nullable: true })
  parking_details!: string | null

  @ApiProperty({ type: String, nullable: true })
  reservation_details!: string | null

  @ApiProperty({ type: String, nullable: true })
  source_url!: string | null

  @ApiProperty({ type: String, nullable: true })
  source_name!: string | null

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "Raw PostgreSQL timestamp of the last successful retrieval of this listing's source details; null when unavailable",
  })
  source_details_fetched_at!: string | null

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

  @ApiProperty({
    enum: ["confirmed", "unknown"],
    nullable: true,
    description: "Age suitability for the selected ages; null when ages were not selected",
  })
  age_match!: "confirmed" | "unknown" | null

  @ApiProperty({
    type: "object",
    additionalProperties: { type: "string", enum: ["confirmed", "contradicted", "unknown"] },
  })
  family_needs!: EnrichedEvent["family_needs"]
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

export class SimilarEventDto implements SimilarEvent {
  @ApiProperty({ format: "uuid" })
  event_id!: string

  @ApiProperty()
  title!: string
}

export class EventCommentDto implements PublicEventComment {
  @ApiProperty({ format: "uuid" })
  id!: string

  @ApiProperty()
  body!: string

  @ApiProperty({ format: "date-time" })
  created_at!: string

  @ApiProperty({ format: "date-time" })
  updated_at!: string

  @ApiProperty({ type: String, nullable: true })
  display_name!: string | null

  @ApiProperty({ type: String, nullable: true })
  avatar_url!: string | null
}

export class EventDetailDto {
  @ApiProperty({ type: EnrichedEventDto, nullable: true })
  event!: EnrichedEventDto | null

  @ApiProperty({ type: [SimilarEventDto] })
  similar!: SimilarEventDto[]

  @ApiProperty({ type: [EventCommentDto] })
  comments!: EventCommentDto[]

  @ApiProperty({ type: "integer", minimum: 1, maximum: 5, nullable: true })
  my_rating!: number | null

  @ApiProperty()
  signed_in!: boolean
}

export class MapEventDto {
  @ApiProperty({ format: "uuid" })
  id!: string

  @ApiProperty()
  title!: string

  @ApiProperty({ type: "number", format: "double" })
  latitude!: number

  @ApiProperty({ type: "number", format: "double" })
  longitude!: number

  @ApiProperty({ format: "date-time" })
  start_datetime!: string

  @ApiProperty({ type: String, nullable: true })
  timezone!: string | null

  @ApiProperty({ type: String, nullable: true })
  venue_name!: string | null

  @ApiProperty()
  is_free!: boolean

  @ApiProperty({ enum: ["free", "paid", "unknown"] })
  admission_cost_state!: "free" | "paid" | "unknown"

  @ApiProperty({ type: String, nullable: true })
  admission_amount!: string | null

  @ApiProperty({
    enum: ["confirmed", "unknown"],
    nullable: true,
    description: "Age suitability for the selected ages; null when ages were not selected",
  })
  age_match!: "confirmed" | "unknown" | null

  @ApiProperty({
    type: "object",
    additionalProperties: { type: "string", enum: ["confirmed", "contradicted", "unknown"] },
  })
  family_needs!: EnrichedEvent["family_needs"]
}

export class MapEventsDto {
  @ApiProperty({ type: [MapEventDto], maxItems: 200 })
  events!: MapEventDto[]

  @ApiProperty({ type: "integer", minimum: 0 })
  omitted_without_coordinates!: number
}

export enum DiscoveryRangeDto {
  Today = "today",
  Weekend = "weekend",
  Upcoming = "upcoming",
}

export enum AdmissionCostFilterDto {
  Any = "any",
  Free = "free",
  Paid = "paid",
  Unknown = "unknown",
}

export class MapQueryDto {
  @ApiPropertyOptional({ format: "uuid" })
  city_id?: string

  @ApiPropertyOptional({
    description: "Comma-separated, unique child ages from 0 through 17 (maximum 10)",
    example: "2,7",
  })
  ages?: string

  @ApiPropertyOptional({
    description: "Comma-separated conjunctive family-needs criteria",
    example: "indoor,wheelchair_accessible",
  })
  family_needs?: string

  @ApiPropertyOptional({ enum: ["true", "false"], default: "false" })
  include_unknown_family_needs?: "true" | "false"

  @ApiPropertyOptional({ enum: ["all", "any"], default: "all" })
  age_mode?: "all" | "any"

  @ApiPropertyOptional({ default: false })
  include_unknown_age?: boolean
}

export class FavoriteEventsDto {
  @ApiProperty({ type: [EnrichedEventDto] })
  events!: EnrichedEventDto[]
}

export class CalendarEventDto implements CalendarEvent {
  @ApiProperty({ format: "uuid" })
  event_id!: string

  @ApiProperty({ format: "date-time" })
  added_at!: string

  @ApiProperty({ type: String, nullable: true })
  notes!: string | null

  @ApiProperty()
  title!: string

  @ApiProperty({ format: "date-time" })
  start_datetime!: string

  @ApiProperty({ type: String, format: "date-time", nullable: true })
  end_datetime!: string | null

  @ApiProperty({ type: String, nullable: true })
  venue_name!: string | null

  @ApiProperty({ type: String, nullable: true })
  address!: string | null

  @ApiProperty({ type: String, format: "uuid", nullable: true })
  city_id!: string | null

  @ApiProperty()
  is_free!: boolean

  @ApiProperty({ type: String, nullable: true })
  price!: string | null

  @ApiProperty(JSON_VALUE_PROPERTY)
  images!: Json
}

export class CalendarEventsDto {
  @ApiProperty({ type: [CalendarEventDto] })
  entries!: CalendarEventDto[]
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

  @ApiPropertyOptional({ maxLength: 100 })
  keyword?: string

  @ApiPropertyOptional({
    type: String,
    format: "date-time",
    description: "Legacy explicit lower bound; cannot be combined with range",
  })
  date_from?: string

  @ApiPropertyOptional({
    type: String,
    format: "date-time",
    description: "Legacy explicit upper bound; cannot be combined with range",
  })
  date_to?: string

  @ApiPropertyOptional()
  is_free?: boolean

  @ApiPropertyOptional({ type: "integer", minimum: 0 })
  kid_age?: number

  @ApiPropertyOptional({
    description:
      "Comma-separated, unique child ages from 0 through 17 (maximum 10); cannot be combined with kid_age",
    example: "2,7",
  })
  ages?: string

  @ApiPropertyOptional({ enum: ["all", "any"], default: "all" })
  age_mode?: "all" | "any"

  @ApiPropertyOptional({ default: false })
  include_unknown_age?: boolean

  @ApiPropertyOptional({
    description: "Comma-separated conjunctive family-needs criteria",
    example: "indoor,wheelchair_accessible",
  })
  family_needs?: string

  @ApiPropertyOptional({ enum: ["true", "false"], default: "false" })
  include_unknown_family_needs?: "true" | "false"

  @ApiPropertyOptional({ description: "Base64 keyset cursor returned by the previous page" })
  cursor?: string

  @ApiPropertyOptional({ type: "integer", minimum: 1, maximum: 100, default: 24 })
  limit?: number
}
