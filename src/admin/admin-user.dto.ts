import { ApiProperty, type ApiBodyOptions } from "@nestjs/swagger"

const RAW_TIMESTAMP_DESCRIPTION =
  "Raw timestamp string preserving PostgreSQL microsecond precision; pass it unchanged."

type RequestBodySchema = Extract<ApiBodyOptions, { schema: unknown }>["schema"]

export class AdminUserAccessDto {
  @ApiProperty({ format: "uuid" })
  user_id!: string

  @ApiProperty()
  is_enabled!: boolean

  @ApiProperty({ type: String, nullable: true, description: RAW_TIMESTAMP_DESCRIPTION })
  access_expires_at!: string | null

  @ApiProperty({ type: String, nullable: true, description: RAW_TIMESTAMP_DESCRIPTION })
  enabled_at!: string | null

  @ApiProperty({ type: String, nullable: true, description: RAW_TIMESTAMP_DESCRIPTION })
  disabled_at!: string | null

  @ApiProperty({ type: String, nullable: true, maxLength: 1000 })
  disabled_reason!: string | null

  @ApiProperty({ type: String, nullable: true })
  display_name!: string | null

  @ApiProperty({ type: String, nullable: true })
  email!: string | null

  @ApiProperty({ type: String, enum: ["user", "admin"], nullable: true })
  role!: "user" | "admin" | null

  @ApiProperty({ type: String, nullable: true, description: RAW_TIMESTAMP_DESCRIPTION })
  profile_created_at!: string | null

  @ApiProperty({ type: String, description: RAW_TIMESTAMP_DESCRIPTION })
  created_at!: string

  @ApiProperty({ type: String, description: RAW_TIMESTAMP_DESCRIPTION })
  updated_at!: string
}

export class AdminUserMutationResultDto {
  @ApiProperty({ type: Boolean, enum: [true] })
  ok!: true
}

export const ADMIN_SET_USER_ACCESS_BODY_SCHEMA: RequestBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["is_enabled"],
  properties: {
    is_enabled: { type: "boolean" },
    disabled_reason: {
      type: "string",
      nullable: true,
      maxLength: 1000,
      description: "Ignored when enabling. Trimmed; null, omitted, or blank becomes null.",
    },
  },
}
