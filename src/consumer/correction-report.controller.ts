import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common"
import {
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOperation,
  ApiParam,
  ApiNoContentResponse,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
  ApiTooManyRequestsResponse,
} from "@nestjs/swagger"
import type { Response } from "express"

import {
  OptionalClerkAuthGuard,
  type OptionalIdentifiedRequest,
} from "../auth/optional-clerk.guard.js"
import { newAnonymousCapability, parseCorrectionReport } from "./correction-report.input.js"
import {
  CorrectionReportService,
  type SubmittedCorrectionReport,
} from "./correction-report.service.js"

class CorrectionReportContactDto {
  @ApiPropertyOptional({ format: "email", maxLength: 320 }) email?: string
  @ApiPropertyOptional({ minLength: 7, maxLength: 32, pattern: "^\\+?[0-9 ()-]{7,32}$" })
  phone?: string
}

class CorrectionReportSubmissionDto {
  @ApiProperty({
    enum: [
      "cancellation",
      "wrong_date_time",
      "wrong_location",
      "wrong_cost",
      "accessibility",
      "other",
    ],
  })
  category!: string
  @ApiProperty({ minLength: 1, maxLength: 2000 }) details!: string
  @ApiPropertyOptional({ type: CorrectionReportContactDto, description: "Private" })
  contact?: CorrectionReportContactDto
  @ApiPropertyOptional({
    type: [String],
    maxItems: 5,
    description: "Private; HTTP(S) URLs only",
  })
  evidence_urls?: string[]
}

class SubmittedCorrectionReportDto {
  @ApiProperty({ format: "uuid" }) id!: string
  @ApiProperty({ enum: ["new"] }) status!: string
  @ApiProperty({ type: "integer" }) priority!: number
  @ApiProperty({ format: "date-time" }) created_at!: string
}

function readCapabilityCookie(request: OptionalIdentifiedRequest): string | undefined {
  const value = request.headers.cookie
    ?.split(";")
    .map((part) => part.trim().split("="))
    .find(([name]) => name === "correction_report_capability")?.[1]
  return value === undefined ? undefined : decodeURIComponent(value)
}

@ApiTags("events")
@Controller("v1/events")
export class CorrectionReportController {
  constructor(private readonly reports: CorrectionReportService) {}

  @Post(":eventId/correction-reports")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(OptionalClerkAuthGuard)
  @ApiOperation({
    operationId: "submitCorrectionReport",
    summary: "Privately report incorrect event details, with or without an account",
    security: [{}, { clerk: [] }],
  })
  @ApiParam({ name: "eventId", format: "uuid" })
  @ApiBody({ type: CorrectionReportSubmissionDto })
  @ApiCreatedResponse({
    type: SubmittedCorrectionReportDto,
    description: "Private fields are never echoed",
  })
  @ApiConflictResponse({ description: "Duplicate or unavailable event" })
  @ApiTooManyRequestsResponse({ description: "Short-lived submission control" })
  async submit(
    @Param("eventId") eventId: string,
    @Body() body: unknown,
    @Req() request: OptionalIdentifiedRequest,
    @Res({ passthrough: true }) response: Response
  ): Promise<SubmittedCorrectionReport> {
    const replacement = newAnonymousCapability()
    const report = await this.reports.submit(
      eventId,
      parseCorrectionReport(body),
      request.identity?.supabaseUuid ?? null,
      readCapabilityCookie(request),
      replacement
    )
    if (request.identity === undefined) {
      response.cookie("correction_report_capability", replacement, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: 15 * 60 * 1000,
        path: "/v1/events",
      })
    }
    return report
  }
}

@ApiTags("events")
@Controller("v1")
export class CorrectionReportCapabilityController {
  constructor(private readonly reports: CorrectionReportService) {}

  @Post("correction-report-capability")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(OptionalClerkAuthGuard)
  @ApiOperation({
    operationId: "mintCorrectionReportCapability",
    summary: "Mint a short-lived anonymous correction-report capability",
    security: [{}, { clerk: [] }],
  })
  @ApiNoContentResponse({ description: "Capability set in an HttpOnly cookie" })
  @ApiTooManyRequestsResponse({ description: "Global short-lived issuance budget exhausted" })
  async mint(@Res({ passthrough: true }) response: Response): Promise<void> {
    const capability = newAnonymousCapability()
    await this.reports.mintAnonymousCapability(capability)
    response.cookie("correction_report_capability", capability, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 15 * 60 * 1000,
      path: "/v1/events",
    })
  }
}
