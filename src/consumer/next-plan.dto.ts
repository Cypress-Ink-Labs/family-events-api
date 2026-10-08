import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger"
import { EnrichedEventDto } from "./consumer.dto.js"
import type { WeatherSnapshot } from "./weather.service.js"

export class NextPlanQueryDto {
  @ApiPropertyOptional({ format: "uuid" }) city_id?: string
  @ApiPropertyOptional({ type: "integer", minimum: 0, maximum: 18 }) kid_age?: number
  @ApiPropertyOptional({ minimum: -90, maximum: 90 }) lat?: number
  @ApiPropertyOptional({ minimum: -180, maximum: 180 }) lng?: number
}

export class PlanWeatherDto implements WeatherSnapshot {
  @ApiProperty() available!: boolean
  @ApiProperty({ enum: ["outdoor", "indoor", "any", "neutral"] })
  weatherFit!: WeatherSnapshot["weatherFit"]
  @ApiProperty({ type: Number, nullable: true }) temperatureC!: number | null
  @ApiProperty({ type: String, nullable: true }) condition!: string | null
  @ApiProperty({ type: String, format: "date-time", nullable: true }) observedAt!: string | null
}

export class NextPlanContextDto {
  @ApiProperty({ type: Number, nullable: true }) child_age!: number | null
  @ApiProperty({ type: [String] }) city_ids!: string[]
  @ApiProperty({ enum: ["device", "city", "none"] }) location_source!: "device" | "city" | "none"
}

export class NextPlannedEventDto {
  @ApiProperty({ type: EnrichedEventDto }) event!: EnrichedEventDto
  @ApiProperty() score!: string
  @ApiProperty({ type: [String] }) reasons!: string[]
  @ApiProperty({ type: Number, nullable: true }) distance_km!: number | null
}

export class NextPlanDto {
  @ApiProperty() available!: boolean
  @ApiProperty({ type: String, format: "date", nullable: true }) date!: string | null
  @ApiProperty({ type: Number, nullable: true, minimum: 0, maximum: 7 }) day_offset!: number | null
  @ApiProperty() timezone!: string
  @ApiProperty({ type: NextPlanContextDto }) context!: NextPlanContextDto
  @ApiProperty({
    type: PlanWeatherDto,
    description: "Current observed weather, not a forecast for future plan dates",
  })
  weather!: PlanWeatherDto
  @ApiProperty({ type: [NextPlannedEventDto] }) planned!: NextPlannedEventDto[]
}
