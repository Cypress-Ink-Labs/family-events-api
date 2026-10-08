import {
  Body,
  Controller,
  Get,
  Req,
  UseGuards,
  Post,
  HttpCode,
  BadRequestException,
  HttpException,
  ServiceUnavailableException,
} from "@nestjs/common"
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiTags,
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiConflictResponse,
  ApiServiceUnavailableResponse,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger"
import { ClerkAuthGuard, type AuthenticatedRequest } from "../auth/clerk.guard.js"
import { OnboardingReceiptDto, OnboardingStatusDto, OnboardingPolicyDto } from "./onboarding.dto.js"
import { OnboardingService } from "./onboarding.service.js"

@ApiTags("onboarding")
@ApiServiceUnavailableResponse({
  description: "Invitation service unavailable; retry without assuming access was granted.",
})
@Controller("v1/onboarding")
export class OnboardingController {
  constructor(private readonly enrollment: OnboardingService) {}
  private async available<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action()
    } catch (error) {
      if (error instanceof HttpException) throw error
      throw new ServiceUnavailableException("Invitation service is unavailable. Try again.")
    }
  }
  @ApiBearerAuth("clerk")
  @ApiUnauthorizedResponse()
  @ApiForbiddenResponse({
    description: "Disabled, expired, or previously claimed account cannot enroll again.",
  })
  @ApiConflictResponse({ description: "Trusted identity mapping is still being provisioned." })
  @ApiBadRequestResponse({
    description: "Invalid code or exhausted, expired, revoked, rate-limited invitation.",
  })
  @Post("redeem")
  @HttpCode(200)
  @UseGuards(ClerkAuthGuard)
  @ApiBody({
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["code"],
      properties: { code: { type: "string", minLength: 1, maxLength: 128 } },
    },
  })
  @ApiOkResponse({ type: OnboardingStatusDto })
  redeem(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    if (typeof body !== "object" || body === null || Array.isArray(body))
      throw new BadRequestException("Provide an invitation code")
    const input = body as Record<string, unknown>
    if (
      Object.keys(input).some((key) => key !== "code") ||
      typeof input.code !== "string" ||
      !input.code.trim() ||
      input.code.length > 128
    )
      throw new BadRequestException("Provide an invitation code")
    return this.available(() =>
      this.enrollment.redeem(request.user.clerkUserId, input.code as string)
    )
  }
  @Post("requests")
  @HttpCode(200)
  @ApiBody({
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["email"],
      properties: {
        email: { type: "string", format: "email", maxLength: 320 },
        message: { type: "string", nullable: true, maxLength: 500 },
      },
    },
  })
  @ApiOkResponse({ type: OnboardingReceiptDto })
  request(@Body() body: unknown) {
    if (typeof body !== "object" || body === null || Array.isArray(body))
      throw new BadRequestException("Provide an email address")
    const input = body as Record<string, unknown>
    if (
      Object.keys(input).some((key) => key !== "email" && key !== "message") ||
      typeof input.email !== "string"
    )
      throw new BadRequestException("Provide an email address")
    const email = input.email.trim().toLowerCase()
    if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new BadRequestException("Provide a valid email address")
    if (
      input.message != null &&
      (typeof input.message !== "string" || input.message.trim().length > 500)
    )
      throw new BadRequestException("Message must be at most 500 characters")
    return this.available(() =>
      this.enrollment.request(
        email,
        typeof input.message === "string" ? input.message.trim() || null : null
      )
    )
  }
  @ApiBearerAuth("clerk")
  @ApiUnauthorizedResponse()
  @Get("me")
  @UseGuards(ClerkAuthGuard)
  @ApiOkResponse({ type: OnboardingStatusDto })
  status(@Req() request: AuthenticatedRequest) {
    return this.available(() => this.enrollment.status(request.user.clerkUserId))
  }
  @Get()
  @ApiOkResponse({ type: OnboardingPolicyDto })
  policy() {
    return this.available(() => this.enrollment.policy())
  }
}
