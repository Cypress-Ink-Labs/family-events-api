import { ApiProperty } from "@nestjs/swagger"
import { EnrichedEventDto } from "./consumer.dto.js"

export class SavedEventDto extends EnrichedEventDto {
  @ApiProperty({ type: Number, nullable: true, minimum: 1, maximum: 5 }) my_rating!: number | null
  @ApiProperty({ type: String, nullable: true }) calendar_notes!: string | null
  @ApiProperty({ type: String, format: "date-time", nullable: true }) calendar_added_at!:
    | string
    | null
}

export class SavedEventsDto {
  @ApiProperty({ type: [SavedEventDto] }) events!: SavedEventDto[]
}
