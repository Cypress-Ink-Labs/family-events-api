import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common"
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger"

import { ClerkAuthGuard } from "../auth/clerk.guard.js"
import { MappedIdentityGuard, type IdentifiedRequest } from "../auth/mapped-identity.guard.js"
import { OperatorGuard } from "../auth/operator.guard.js"
import { parseAdminEventId } from "../admin/admin-review.input.js"
import { AdminErrorDto, AdminValidationErrorDto } from "../admin/admin-review.dto.js"
import { parseFamilyNeedEvidence, parseFamilyNeedReassessment } from "./admin-family-needs.input.js"
import type { FamilyNeedEvidenceRow } from "./admin-family-needs.repository.js"
import { AdminFamilyNeedsService } from "./admin-family-needs.service.js"

const FAMILY_NEED_CLAIMS = [
  "indoor",
  "outdoor",
  "wheelchair_accessible",
  "sensory_friendly",
  "stroller_friendly",
] as const

class FamilyNeedEvidenceInputDto {
  @ApiProperty({ enum: FAMILY_NEED_CLAIMS }) claim!: string
  @ApiProperty({ enum: ["supported", "unsupported"] }) value!: string
  @ApiProperty({ enum: ["source_statement", "human", "organizer"] }) provenance_type!: string
  @ApiPropertyOptional({ type: String, format: "uri", nullable: true }) source_url?: string | null
  @ApiProperty({ minLength: 1, maxLength: 4000 }) statement!: string
  @ApiProperty({ format: "date-time" }) observed_at!: string
}

class FamilyNeedReassessmentInputDto {
  @ApiProperty({ format: "uuid" }) evidence_id!: string
  @ApiProperty({ minLength: 1, maxLength: 1000 }) reason!: string
}

class FamilyNeedEvidenceRowDto {
  @ApiProperty({ format: "uuid" }) id!: string
  @ApiProperty({ format: "uuid" }) event_id!: string
  @ApiProperty({ enum: FAMILY_NEED_CLAIMS }) claim!: string
  @ApiProperty({ enum: ["supported", "unsupported"] }) value!: string
  @ApiProperty({ enum: ["source_statement", "human", "organizer"] }) provenance_type!: string
  @ApiProperty({ type: String, format: "uri", nullable: true }) source_url!: string | null
  @ApiProperty() statement!: string
  @ApiProperty({ format: "date-time" }) observed_at!: string
  @ApiProperty({ format: "date-time" }) recorded_at!: string
  @ApiProperty({ type: String, format: "uuid", nullable: true }) recorded_by!: string | null
  @ApiProperty({ type: String, nullable: true }) applicable_venue_name!: string | null
  @ApiProperty({ type: String, nullable: true }) applicable_address!: string | null
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  applicable_start_datetime!: string | null
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  applicable_end_datetime!: string | null
  @ApiProperty({ type: String, format: "date-time", nullable: true }) invalidated_at!: string | null
  @ApiProperty({ type: String, nullable: true }) invalidation_reason!: string | null
  @ApiPropertyOptional() has_conflict?: boolean
}

@ApiTags("admin")
@ApiBearerAuth("clerk")
@ApiUnauthorizedResponse({ type: AdminErrorDto })
@ApiForbiddenResponse({ type: AdminErrorDto })
@ApiNotFoundResponse({ type: AdminErrorDto })
@ApiBadRequestResponse({ type: AdminValidationErrorDto })
@UseGuards(ClerkAuthGuard, MappedIdentityGuard, OperatorGuard)
@Controller("v1/admin/events")
export class AdminFamilyNeedsController {
  constructor(private readonly familyNeeds: AdminFamilyNeedsService) {}

  @Get(":id/family-needs")
  @ApiOperation({ operationId: "adminListFamilyNeedEvidence" })
  @ApiOkResponse({
    type: [FamilyNeedEvidenceRowDto],
    description: "Evidence history, including conflicts and invalidated rows",
  })
  list(@Param("id") id: string, @Req() request: Pick<IdentifiedRequest, "identity">) {
    return this.familyNeeds.list(parseAdminEventId(id), request.identity.supabaseUuid)
  }

  @Post(":id/family-needs/evidence")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ operationId: "adminAddFamilyNeedEvidence" })
  @ApiBody({ type: FamilyNeedEvidenceInputDto })
  @ApiOkResponse({ type: FamilyNeedEvidenceRowDto, description: "Evidence recorded" })
  add(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: Pick<IdentifiedRequest, "identity">
  ): Promise<FamilyNeedEvidenceRow> {
    return this.familyNeeds.add(
      parseAdminEventId(id),
      request.identity.supabaseUuid,
      parseFamilyNeedEvidence(body)
    )
  }

  @Post(":id/family-needs/reassess")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ operationId: "adminReassessFamilyNeedEvidence" })
  @ApiBody({ type: FamilyNeedReassessmentInputDto })
  @ApiOkResponse({
    type: FamilyNeedEvidenceRowDto,
    description: "Evidence invalidated pending reassessment",
  })
  reassess(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: Pick<IdentifiedRequest, "identity">
  ): Promise<FamilyNeedEvidenceRow> {
    return this.familyNeeds.reassess(
      parseAdminEventId(id),
      request.identity.supabaseUuid,
      parseFamilyNeedReassessment(body)
    )
  }
}
