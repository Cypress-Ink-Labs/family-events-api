import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common"
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger"

import { ClerkAuthGuard } from "../auth/clerk.guard.js"
import { MappedIdentityGuard, type IdentifiedRequest } from "../auth/mapped-identity.guard.js"
import { PlanQueryDto, PlanResponseDto } from "./consumer.dto.js"
import { parsePlanQuery } from "./consumer.query.js"
import { ConsumerService } from "./consumer.service.js"

@ApiTags("consumer")
@ApiBearerAuth("clerk")
@ApiUnauthorizedResponse({ description: "Missing or invalid bearer token" })
@ApiForbiddenResponse({ description: "User is not provisioned" })
@UseGuards(ClerkAuthGuard, MappedIdentityGuard)
@Controller("v1")
export class PlanController {
  constructor(private readonly consumer: ConsumerService) {}

  @Get("plan")
  @ApiOperation({ summary: "Plan events for today" })
  @ApiQuery({ type: PlanQueryDto })
  @ApiOkResponse({ type: PlanResponseDto })
  @ApiBadRequestResponse({ description: "Invalid query parameters" })
  getPlan(
    @Query() query: Record<string, unknown>,
    @Req() request: IdentifiedRequest
  ): Promise<PlanResponseDto> {
    return this.consumer.planForToday(parsePlanQuery(query), request.identity.supabaseUuid)
  }
}
