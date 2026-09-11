import { Controller, Get, Param, Query, Req, UseGuards } from "@nestjs/common"
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger"

import { ClerkAuthGuard } from "../auth/clerk.guard.js"
import { MappedIdentityGuard, type IdentifiedRequest } from "../auth/mapped-identity.guard.js"
import { OperatorGuard } from "../auth/operator.guard.js"
import { AdminErrorDto, AdminValidationErrorDto } from "./admin-review.dto.js"
import { AdminCronRunDetailDto, AdminCronRunsDto, AdminCronSchedulesDto } from "./admin-cron.dto.js"
import {
  CRON_LABELS,
  parseCronListQuery,
  parseCronRunId,
  parseCronRunsQuery,
} from "./admin-cron.input.js"
import { AdminCronService } from "./admin-cron.service.js"

type AdminRequest = Pick<IdentifiedRequest, "identity">
@ApiTags("admin")
@ApiBearerAuth("clerk")
@ApiUnauthorizedResponse({ type: AdminErrorDto })
@ApiForbiddenResponse({ type: AdminErrorDto })
@ApiNotFoundResponse({ type: AdminErrorDto })
@ApiBadRequestResponse({ type: AdminValidationErrorDto })
@UseGuards(ClerkAuthGuard, MappedIdentityGuard, OperatorGuard)
@Controller("v1/admin/crons")
export class AdminCronController {
  constructor(private readonly service: AdminCronService) {}
  @Get()
  @ApiOperation({ operationId: "adminListCrons", summary: "List code-owned cron schedules" })
  @ApiOkResponse({ type: AdminCronSchedulesDto })
  list(@Query() query: Record<string, unknown>, @Req() request: AdminRequest) {
    parseCronListQuery(query)
    return this.service.schedules(request.identity.supabaseUuid)
  }
  @Get("runs")
  @ApiOperation({ operationId: "adminListCronRuns", summary: "List cron run history" })
  @ApiQuery({ name: "label", required: false, enum: CRON_LABELS })
  @ApiQuery({ name: "limit", required: false, type: Number, minimum: 1, maximum: 200 })
  @ApiOkResponse({ type: AdminCronRunsDto })
  runs(@Query() query: Record<string, unknown>, @Req() request: AdminRequest) {
    const parsed = parseCronRunsQuery(query)
    return this.service.runs(request.identity.supabaseUuid, parsed.label, parsed.limit)
  }
  @Get("runs/:id")
  @ApiOperation({ operationId: "adminGetCronRun", summary: "Get one cron run and its logs" })
  @ApiParam({ name: "id", schema: { type: "string", pattern: "^[1-9]\\d*$" } })
  @ApiOkResponse({ type: AdminCronRunDetailDto })
  detail(@Param("id") id: string, @Req() request: AdminRequest) {
    return this.service.detail(request.identity.supabaseUuid, parseCronRunId(id))
  }
}
