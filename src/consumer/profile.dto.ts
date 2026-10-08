import { ApiProperty } from "@nestjs/swagger"

export class UserProfileDto {
  @ApiProperty({ type: String, nullable: true })
  display_name!: string | null
  @ApiProperty({ type: String, nullable: true })
  child_name!: string | null
  @ApiProperty({ type: "integer", minimum: 0, maximum: 18, nullable: true })
  child_age!: number | null
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  city_preference_id!: string | null
  @ApiProperty({ enum: ["light", "dark", "system"], nullable: true })
  theme_preference!: "light" | "dark" | "system" | null
}

export class ProfileUpdateDto {
  @ApiProperty({ type: String, nullable: true, required: false })
  display_name?: string | null
  @ApiProperty({ type: String, nullable: true, required: false })
  child_name?: string | null
  @ApiProperty({ type: "integer", minimum: 0, maximum: 18, nullable: true, required: false })
  child_age?: number | null
  @ApiProperty({ enum: ["light", "dark", "system"], required: false })
  theme_preference?: "light" | "dark" | "system"
}
