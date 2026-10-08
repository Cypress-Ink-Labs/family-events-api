import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Put,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common"
import {
  ApiBadRequestResponse,
  ApiAcceptedResponse,
  ApiBody,
  ApiConflictResponse,
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
import {
  AdminCronRunDetailDto,
  AdminCronRunsDto,
  AdminCronSchedulesDto,
  AdminCronOwnerDto,
  AdminCronReceiptDto,
} from "./admin-cron.dto.js"
import { AdminCronControlsService } from "./admin-cron-controls.service.js"
import {
  CRON_LABELS,
  parseCronListQuery,
  parseCronRunId,
  parseCronRunsQuery,
  parseCronLabel,
  parseCronOwner,
  parseCronRunBody,
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
  constructor(
    private readonly service: AdminCronService,
    private readonly controls?: AdminCronControlsService
  ) {}
  @Put(":label/owner")
  @ApiOperation({
    operationId: "adminSetCronOwner",
    summary: "Transfer or pause one supported schedule",
  })
  @ApiParam({ name: "label", enum: CRON_LABELS })
  @ApiBody({
    schema: {
      type: "object",
      required: ["owner"],
      additionalProperties: false,
      properties: { owner: { type: "string", enum: ["api", "legacy", "paused"] } },
    },
  })
  @ApiConflictResponse({ type: AdminErrorDto })
  @ApiOkResponse({ type: AdminCronOwnerDto })
  setOwner(
    @Param("label") label: string,
    @Query() query: Record<string, unknown>,
    @Body() body: unknown,
    @Req() request: AdminRequest
  ) {
    parseCronListQuery(query)
    return this.controls!.setOwner(
      request.identity.supabaseUuid,
      parseCronLabel(label),
      parseCronOwner(body)
    )
  }
  @Post(":label/run")
  @HttpCode(202)
  @ApiOperation({
    operationId: "adminRunCron",
    summary: "Queue a supported task under its current ownership gates",
  })
  @ApiParam({ name: "label", enum: CRON_LABELS })
  @ApiBody({ schema: { type: "object", additionalProperties: false } })
  @ApiConflictResponse({ type: AdminErrorDto })
  @ApiAcceptedResponse({ type: AdminCronReceiptDto })
  run(
    @Param("label") label: string,
    @Query() query: Record<string, unknown>,
    @Body() body: unknown,
    @Req() request: AdminRequest
  ) {
    parseCronListQuery(query)
    parseCronRunBody(body)
    return this.controls!.run(request.identity.supabaseUuid, parseCronLabel(label))
  }
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
