import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common"
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger"

import { ClerkAuthGuard } from "../auth/clerk.guard.js"
import { MappedIdentityGuard, type IdentifiedRequest } from "../auth/mapped-identity.guard.js"
import { OperatorGuard } from "../auth/operator.guard.js"
import { AdminErrorDto, AdminValidationErrorDto } from "./admin-review.dto.js"
import { AdminDashboardStatsDto, AdminPipelineStatsDto } from "./admin-statistics.dto.js"
import { parseAdminDashboardQuery, parseAdminPipelineQuery } from "./admin-statistics.input.js"
import { AdminStatisticsService } from "./admin-statistics.service.js"

type AdminRequest = Pick<IdentifiedRequest, "identity">

@ApiTags("admin")
@ApiBearerAuth("clerk")
@ApiUnauthorizedResponse({ type: AdminErrorDto })
@ApiForbiddenResponse({ type: AdminErrorDto })
@ApiNotFoundResponse({ type: AdminErrorDto })
@ApiBadRequestResponse({ type: AdminValidationErrorDto })
@UseGuards(ClerkAuthGuard, MappedIdentityGuard, OperatorGuard)
@Controller("v1/admin")
export class AdminStatisticsController {
  constructor(private readonly statistics: AdminStatisticsService) {}

  @Get("dashboard/stats")
  @ApiOperation({ operationId: "adminDashboardStats", summary: "Get admin dashboard statistics" })
  @ApiOkResponse({ type: AdminDashboardStatsDto })
  dashboard(
    @Query() query: Record<string, unknown>,
    @Req() request: AdminRequest
  ): Promise<AdminDashboardStatsDto> {
    parseAdminDashboardQuery(query)
    return this.statistics.dashboard(request.identity.supabaseUuid)
  }

  @Get("statistics/pipeline")
  @ApiOperation({ operationId: "adminPipelineStats", summary: "Get pipeline learning statistics" })
  @ApiQuery({ name: "window_days", required: false, type: Number, minimum: 1, maximum: 365 })
  @ApiOkResponse({ type: AdminPipelineStatsDto })
  pipeline(
    @Query() query: Record<string, unknown>,
    @Req() request: AdminRequest
  ): Promise<AdminPipelineStatsDto> {
    return this.statistics.pipeline(request.identity.supabaseUuid, parseAdminPipelineQuery(query))
  }
}
