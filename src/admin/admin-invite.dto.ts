import { ApiProperty, type ApiBodyOptions } from "@nestjs/swagger"

type RequestBodySchema = Extract<ApiBodyOptions, { schema: unknown }>["schema"]
const RAW_TIMESTAMP = "Raw timestamp string preserving PostgreSQL precision."

export class AdminInviteRequiredDto {
  @ApiProperty()
  required!: boolean
}

export class AdminInviteCodeDto {
  @ApiProperty({ format: "uuid" }) id!: string
  @ApiProperty({ type: "integer", minimum: 1, maximum: 10000 }) max_uses!: number
  @ApiProperty({ type: "integer", minimum: 0 }) used_count!: number
  @ApiProperty({ type: String, nullable: true, description: RAW_TIMESTAMP }) expires_at!:
    | string
    | null
  @ApiProperty({ type: String, nullable: true, description: RAW_TIMESTAMP }) revoked_at!:
    | string
    | null
  @ApiProperty({ type: String, nullable: true, maxLength: 1000 }) notes!: string | null
  @ApiProperty({ type: String, format: "uuid", nullable: true }) created_by!: string | null
  @ApiProperty({ type: String, description: RAW_TIMESTAMP }) created_at!: string
}

export class AdminCreatedInviteCodeDto {
  @ApiProperty({ format: "uuid" }) id!: string
  @ApiProperty({ description: "One-time plaintext value. It cannot be retrieved again." })
  code!: string
  @ApiProperty({ type: "integer", minimum: 1, maximum: 10000 }) max_uses!: number
  @ApiProperty({ type: String, nullable: true, description: RAW_TIMESTAMP }) expires_at!:
    | string
    | null
  @ApiProperty({ type: String, nullable: true, maxLength: 1000 }) notes!: string | null
  @ApiProperty({ type: String, description: RAW_TIMESTAMP }) created_at!: string
}

export class AdminInviteMutationDto {
  @ApiProperty({ type: Boolean, enum: [true] }) ok!: true
}

export class AdminInviteRequestDto {
  @ApiProperty({ format: "uuid" }) id!: string
  @ApiProperty({ format: "email" }) email!: string
  @ApiProperty({ type: String, nullable: true, maxLength: 500 }) message!: string | null
  @ApiProperty({ enum: ["pending", "approved", "rejected"] }) status!:
    | "pending"
    | "approved"
    | "rejected"
  @ApiProperty({ type: String, format: "uuid", nullable: true }) invite_code_id!: string | null
  @ApiProperty({ type: String, nullable: true, maxLength: 1000 }) admin_notes!: string | null
  @ApiProperty({ type: String, description: RAW_TIMESTAMP }) created_at!: string
  @ApiProperty({ type: String, nullable: true, description: RAW_TIMESTAMP }) reviewed_at!:
    | string
    | null
  @ApiProperty({ type: String, format: "uuid", nullable: true }) reviewed_by!: string | null
}

export class AdminApprovedInviteRequestDto {
  @ApiProperty({ format: "uuid" }) request_id!: string
  @ApiProperty({ description: "One-time plaintext value. It cannot be retrieved again." })
  code!: string
  @ApiProperty({ format: "uuid" }) invite_code_id!: string
  @ApiProperty({ format: "email" }) email!: string
  @ApiProperty({ type: String, description: RAW_TIMESTAMP }) created_at!: string
}

export const ADMIN_CREATE_INVITE_CODE_SCHEMA: RequestBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["max_uses"],
  properties: {
    max_uses: { type: "integer", minimum: 1, maximum: 10000 },
    expires_at: { type: "string", format: "date-time", nullable: true },
    notes: { type: "string", maxLength: 1000, nullable: true },
  },
}

export const ADMIN_REJECT_INVITE_REQUEST_SCHEMA: RequestBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    notes: { type: "string", maxLength: 1000, nullable: true },
  },
}
