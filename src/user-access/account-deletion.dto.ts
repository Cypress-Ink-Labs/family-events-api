import { ApiProperty } from "@nestjs/swagger"
import { AdminUserAccessDto } from "../admin/admin-user.dto.js"
export class AdminManagedUserDto extends AdminUserAccessDto {
  @ApiProperty() is_self!: boolean
  @ApiProperty() can_disable!: boolean
  @ApiProperty() can_enable!: boolean
  @ApiProperty() can_delete!: boolean
}
export class AccountDeletionDto {
  @ApiProperty({ format: "uuid" }) user_id!: string
  @ApiProperty({ enum: ["pending_provider", "pending_cleanup", "cleanup_deferred", "completed"] })
  status!: string
  @ApiProperty({ type: "integer", minimum: 0 }) attempts!: number
  @ApiProperty({ type: String }) requested_at!: string
  @ApiProperty({ type: String, nullable: true }) provider_confirmed_at!: string | null
  @ApiProperty({ type: String, nullable: true }) completed_at!: string | null
  @ApiProperty({ type: String, nullable: true }) last_error!: string | null
  @ApiProperty({ type: String }) updated_at!: string
}
