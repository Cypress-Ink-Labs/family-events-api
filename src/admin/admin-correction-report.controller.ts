import {
  Body,
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common"
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger"
import { z } from "zod"

import { ClerkAuthGuard } from "../auth/clerk.guard.js"
import { MappedIdentityGuard, type IdentifiedRequest } from "../auth/mapped-identity.guard.js"
import { OperatorGuard } from "../auth/operator.guard.js"
import {
  AdminCorrectionReportRepository,
  type CorrectionReportListRow,
} from "./admin-correction-report.repository.js"

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new BadRequestException("invalid correction report request")
  return result.data
}

const uuid = z.string().uuid()
const claim = z.object({ version: z.number().int().positive() }).strict()
const disposition = z
  .object({
    version: z.number().int().positive(),
    outcome: z.enum(["resolved", "dismissed"]),
    note: z.string().trim().min(1).max(2000),
    correction_id: uuid.nullish(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.outcome === "resolved" && value.correction_id == null)
      context.addIssue({ code: "custom", message: "resolved reports require correction_id" })
    if (value.outcome === "dismissed" && value.correction_id != null)
      context.addIssue({ code: "custom", message: "dismissed reports cannot link a correction" })
  })
const correctionLink = z
  .object({
    audit_log_id: uuid,
    note: z.string().trim().min(1).max(2000),
  })
  .strict()
const restriction = z
  .object({
    reason: z.string().trim().min(1).max(1000),
    expires_at: z.string().datetime({ offset: true }),
  })
  .strict()

class CorrectionReportRowDto {
  @ApiProperty({ format: "uuid" }) id!: string
  @ApiProperty({ format: "uuid" }) event_id!: string
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
  @ApiProperty({ type: "integer" }) priority!: number
  @ApiProperty({ enum: ["new", "in_review", "resolved", "dismissed"] }) status!: string
  @ApiProperty({ type: "integer", minimum: 1 }) version!: number
  @ApiProperty({ type: String, format: "uuid", nullable: true }) claimed_by!: string | null
  @ApiProperty({ type: String, format: "date-time", nullable: true }) claimed_at!: string | null
  @ApiProperty({ type: String, format: "uuid", nullable: true }) resolved_by!: string | null
  @ApiProperty({ type: String, format: "date-time", nullable: true }) resolved_at!: string | null
  @ApiProperty({ type: String, format: "uuid", nullable: true }) correction_id!: string | null
  @ApiProperty({ format: "date-time" }) created_at!: string
  @ApiProperty({ format: "date-time" }) updated_at!: string
}

class CorrectionReportQueueRowDto extends CorrectionReportRowDto {
  @ApiProperty() event_title!: string
}

class CorrectionReportPrivateDetailDto extends CorrectionReportRowDto {
  @ApiProperty({ type: String, format: "uuid", nullable: true }) reporter_user_id!: string | null
  @ApiProperty() details!: string
  @ApiProperty({ type: String, nullable: true }) resolution_note!: string | null
}

class CorrectionReportContactDto {
  @ApiPropertyOptional({ format: "email", maxLength: 320 }) email?: string
  @ApiPropertyOptional({ minLength: 7, maxLength: 32, pattern: "^\\+?[0-9 ()-]{7,32}$" })
  phone?: string
}

class CorrectionReportPrivatePayloadDto extends CorrectionReportPrivateDetailDto {
  @ApiProperty() event_title!: string

  @ApiProperty({
    type: CorrectionReportContactDto,
    nullable: true,
    description: "Private optional reporter contact",
  })
  contact!: CorrectionReportContactDto | null

  @ApiProperty({
    type: [String],
    nullable: true,
    description: "Private supporting HTTP(S) URLs",
  })
  evidence!: string[] | null
}

class ClaimCorrectionReportDto {
  @ApiProperty({ type: "integer", minimum: 1 }) version!: number
}
class LinkCorrectionDto {
  @ApiProperty({ format: "uuid" }) audit_log_id!: string
  @ApiProperty({ minLength: 1, maxLength: 2000 }) note!: string
}
class ListingCorrectionDto {
  @ApiProperty({ format: "uuid" }) id!: string
  @ApiProperty({ format: "uuid" }) event_id!: string
  @ApiProperty({ format: "uuid" }) operator_id!: string
  @ApiProperty({ format: "uuid" }) audit_log_id!: string
  @ApiProperty() audit_note!: string
  @ApiProperty({ format: "date-time" }) created_at!: string
}
class DisposeCorrectionReportDto {
  @ApiProperty({ type: "integer", minimum: 1 }) version!: number
  @ApiProperty({ enum: ["resolved", "dismissed"] }) outcome!: string
  @ApiProperty({ minLength: 1, maxLength: 2000 }) note!: string
  @ApiPropertyOptional({ type: String, format: "uuid", nullable: true }) correction_id?:
    | string
    | null
}
class RestrictCorrectionReporterDto {
  @ApiProperty({ minLength: 1, maxLength: 1000 }) reason!: string
  @ApiProperty({ format: "date-time" }) expires_at!: string
}
class OkDto {
  @ApiProperty({ enum: [true] }) ok!: true
}

@ApiTags("admin")
@ApiBearerAuth("clerk")
@UseGuards(ClerkAuthGuard, MappedIdentityGuard, OperatorGuard)
@Controller("v1/admin/correction-reports")
export class AdminCorrectionReportController {
  constructor(private readonly reports: AdminCorrectionReportRepository) {}

  @Get()
  @ApiOperation({ operationId: "adminListCorrectionReports" })
  @ApiQuery({
    name: "status",
    required: false,
    enum: ["new", "in_review", "resolved", "dismissed"],
  })
  @ApiQuery({ name: "limit", required: false, type: Number, minimum: 1, maximum: 200 })
  @ApiOkResponse({ type: [CorrectionReportQueueRowDto] })
  list(
    @Req() request: IdentifiedRequest,
    @Query("status") status?: string,
    @Query("limit") rawLimit?: string
  ): Promise<CorrectionReportListRow[]> {
    const parsedStatus = parse(
      z.enum(["new", "in_review", "resolved", "dismissed"]).optional(),
      status
    )
    const limit = parse(z.coerce.number().int().min(1).max(200).default(50), rawLimit)
    return this.reports.list(request.identity.supabaseUuid, parsedStatus, limit)
  }

  @Get(":id")
  @ApiOperation({ operationId: "adminGetCorrectionReportPrivateDetail" })
  @ApiOkResponse({ type: CorrectionReportPrivatePayloadDto })
  async detail(@Req() request: IdentifiedRequest, @Param("id") rawId: string) {
    const row = await this.reports.detail(request.identity.supabaseUuid, parse(uuid, rawId))
    if (row === null) throw new NotFoundException()
    return row
  }

  @Post(":id/claim")
  @ApiOperation({ operationId: "adminClaimCorrectionReport" })
  @ApiBody({ type: ClaimCorrectionReportDto })
  @ApiCreatedResponse({ type: CorrectionReportPrivateDetailDto })
  async claimReport(
    @Req() request: IdentifiedRequest,
    @Param("id") rawId: string,
    @Body() body: unknown
  ) {
    const input = parse(claim, body)
    try {
      return await this.reports.claim(
        request.identity.supabaseUuid,
        parse(uuid, rawId),
        input.version
      )
    } catch (error) {
      if ((error as { message?: string }).message?.includes("CORRECTION_REPORT_CONFLICT"))
        throw new ConflictException("report changed")
      throw error
    }
  }

  @Post(":id/correction")
  @ApiOperation({ operationId: "adminLinkCorrectionReportEdit" })
  @ApiBody({ type: LinkCorrectionDto })
  @ApiCreatedResponse({ type: ListingCorrectionDto })
  async linkCorrection(
    @Req() request: IdentifiedRequest,
    @Param("id") rawId: string,
    @Body() body: unknown
  ) {
    const input = parse(correctionLink, body)
    const result = await this.reports.linkCorrection(
      request.identity.supabaseUuid,
      parse(uuid, rawId),
      input.audit_log_id,
      input.note
    )
    if (result === null) throw new NotFoundException()
    return result
  }

  @Post(":id/disposition")
  @ApiOperation({ operationId: "adminDisposeCorrectionReport" })
  @ApiBody({ type: DisposeCorrectionReportDto })
  @ApiCreatedResponse({ type: CorrectionReportPrivateDetailDto })
  async dispose(
    @Req() request: IdentifiedRequest,
    @Param("id") rawId: string,
    @Body() body: unknown
  ) {
    const input = parse(disposition, body)
    try {
      return await this.reports.resolve(
        request.identity.supabaseUuid,
        parse(uuid, rawId),
        input.version,
        input.outcome,
        input.note,
        input.correction_id ?? null
      )
    } catch (error) {
      if ((error as { message?: string }).message?.includes("CORRECTION_REPORT_CONFLICT"))
        throw new ConflictException("report changed")
      throw error
    }
  }

  @Post("reporters/:reporterId/abuse-restriction")
  @ApiOperation({ operationId: "adminConfirmCorrectionReporterRestriction" })
  @ApiBody({ type: RestrictCorrectionReporterDto })
  @ApiCreatedResponse({ type: OkDto })
  async restrict(
    @Req() request: IdentifiedRequest,
    @Param("reporterId") reporterId: string,
    @Body() body: unknown
  ): Promise<{ ok: true }> {
    const input = parse(restriction, body)
    await this.reports.restrict(
      request.identity.supabaseUuid,
      parse(uuid, reporterId),
      input.reason,
      input.expires_at
    )
    return { ok: true }
  }
}
