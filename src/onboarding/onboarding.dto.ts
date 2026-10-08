import { ApiProperty } from "@nestjs/swagger"
export class OnboardingPolicyDto {
  @ApiProperty({ type: Boolean }) required!: boolean
}

export class OnboardingStatusDto extends OnboardingPolicyDto {
  @ApiProperty({ enum: ["ready", "invite_required", "provisioning_pending", "access_unavailable"] })
  state!: string
}

export class OnboardingReceiptDto {
  @ApiProperty({ type: Boolean }) received!: boolean
}
