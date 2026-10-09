import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
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
  ApiParam,
  ApiTags,
  ApiQuery,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger"

import { ClerkAuthGuard } from "../auth/clerk.guard.js"
import { MappedIdentityGuard, type IdentifiedRequest } from "../auth/mapped-identity.guard.js"
import { OperatorGuard } from "../auth/operator.guard.js"
import { AdminErrorDto, AdminValidationErrorDto } from "./admin-review.dto.js"
import {
  ADMIN_CREATE_SOURCE_BODY_SCHEMA,
  ADMIN_SOURCE_PROCESSING_MODE_BODY_SCHEMA,
  ADMIN_UPDATE_SOURCE_BODY_SCHEMA,
  AdminSourceDto,
  AdminSourceChoicesDto,
  AdminSourceMutationResultDto,
  AdminSourceScrapeResultDto,
} from "./admin-source.dto.js"
import {
  parseAdminCreateSourceBody,
  parseAdminSourceId,
  parseAdminSourceProcessingModeBody,
  parseAdminSourceScrapeBody,
  parseAdminSourcesQuery,
  parseAdminUpdateSourceBody,
} from "./admin-source.input.js"
import {
  AdminSourceRunsPageDto,
  AdminSourceRunDetailDto,
  AdminActiveQueuePageDto,
} from "./admin-source-diagnostics.dto.js"
import { parseSourceRunsQuery, parseSourceQueuesQuery } from "./admin-source-diagnostics.input.js"
import { AdminSourceService } from "./admin-source.service.js"

type AdminRequest = Pick<IdentifiedRequest, "identity">

@ApiTags("admin")
@ApiBearerAuth("clerk")
@ApiUnauthorizedResponse({
  type: AdminErrorDto,
  description: "A valid Clerk bearer token is required",
})
@ApiForbiddenResponse({
  type: AdminErrorDto,
  description:
    "The Clerk user is not provisioned, or database admin access is not provisioned. Database denial returns the stable message: admin access is not provisioned.",
})
@ApiNotFoundResponse({
  type: AdminErrorDto,
  description: "The mapped user is not an operator, or the source does not exist",
})
@ApiBadRequestResponse({
  type: AdminValidationErrorDto,
  description: "Invalid path, query parameters, request body, or source state",
})
@UseGuards(ClerkAuthGuard, MappedIdentityGuard, OperatorGuard)
@Controller("v1/admin/sources")
export class AdminSourceController {
  constructor(private readonly admin: AdminSourceService) {}

  @Get("runs")
  @ApiOperation({ operationId: "adminSourceRuns", summary: "List protected source runs" })
  @ApiQuery({ name: "source_id", required: false, format: "uuid" })
  @ApiQuery({ name: "status", required: false, enum: ["running", "success", "error", "partial"] })
  @ApiQuery({ name: "limit", required: false, type: Number, minimum: 1, maximum: 200 })
  @ApiQuery({ name: "after_started_at", required: false, type: String })
  @ApiQuery({ name: "after_id", required: false, format: "uuid" })
  @ApiOkResponse({ type: AdminSourceRunsPageDto })
  runs(@Query() query: Record<string, unknown>, @Req() request: AdminRequest) {
    return this.admin.runs(request.identity.supabaseUuid, parseSourceRunsQuery(query))
  }

  @Get("runs/:runId")
  @ApiOperation({
    operationId: "adminSourceRunDetail",
    summary: "Read a source run and extraction logs",
  })
  @ApiParam({ name: "runId", format: "uuid" })
  @ApiOkResponse({ type: AdminSourceRunDetailDto })
  runDetail(
    @Param("runId") id: string,
    @Query() query: Record<string, unknown>,
    @Req() request: AdminRequest
  ) {
    parseAdminSourcesQuery(query)
    return this.admin.runDetail(request.identity.supabaseUuid, parseAdminSourceId(id))
  }

  @Get("queues")
  @ApiOperation({
    operationId: "adminActiveSourceQueues",
    summary: "Read active source or tag queue diagnostics and complete status summaries",
  })
  @ApiQuery({ name: "kind", required: true, enum: ["source", "tag"] })
  @ApiQuery({ name: "source_id", required: false, format: "uuid" })
  @ApiQuery({ name: "limit", required: false, type: Number, minimum: 1, maximum: 200 })
  @ApiQuery({ name: "after_id", required: false, type: String, pattern: "^[1-9]\\d{0,18}$" })
  @ApiOkResponse({ type: AdminActiveQueuePageDto })
  queues(@Query() query: Record<string, unknown>, @Req() request: AdminRequest) {
    return this.admin.queues(request.identity.supabaseUuid, parseSourceQueuesQuery(query))
  }

  @Get("choices")
  @ApiOperation({
    operationId: "adminSourceChoices",
    summary: "List all city choices for source administration",
  })
  @ApiOkResponse({ type: AdminSourceChoicesDto })
  choices(
    @Query() query: Record<string, unknown>,
    @Req() request: AdminRequest
  ): Promise<AdminSourceChoicesDto> {
    parseAdminSourcesQuery(query)
    return this.admin.choices(request.identity.supabaseUuid)
  }

  @Get()
  @ApiOperation({ operationId: "adminListSources", summary: "List event sources" })
  @ApiOkResponse({ type: [AdminSourceDto] })
  list(
    @Query() query: Record<string, unknown>,
    @Req() request: AdminRequest
  ): Promise<AdminSourceDto[]> {
    parseAdminSourcesQuery(query)
    return this.admin.list(request.identity.supabaseUuid)
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ operationId: "adminCreateSource", summary: "Create an event source" })
  @ApiBody({ schema: ADMIN_CREATE_SOURCE_BODY_SCHEMA })
  @ApiOkResponse({ type: AdminSourceDto })
  create(@Body() body: unknown, @Req() request: AdminRequest): Promise<AdminSourceDto> {
    return this.admin.create(request.identity.supabaseUuid, parseAdminCreateSourceBody(body))
  }

  @Put(":id")
  @ApiOperation({ operationId: "adminUpdateSource", summary: "Update an event source" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ schema: ADMIN_UPDATE_SOURCE_BODY_SCHEMA })
  @ApiOkResponse({ type: AdminSourceDto })
  update(
    @Param("id") rawId: string,
    @Body() body: unknown,
    @Req() request: AdminRequest
  ): Promise<AdminSourceDto> {
    const id = parseAdminSourceId(rawId)
    return this.admin.update(request.identity.supabaseUuid, id, parseAdminUpdateSourceBody(body))
  }

  @Post(":id/scrape")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: "adminScrapeSource",
    summary: "Enqueue one active source for scraping",
  })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ type: AdminSourceScrapeResultDto })
  async scrape(
    @Param("id") rawId: string,
    @Body() body: unknown,
    @Req() request: AdminRequest
  ): Promise<AdminSourceScrapeResultDto> {
    const id = parseAdminSourceId(rawId)
    parseAdminSourceScrapeBody(body)
    const result = await this.admin.scrape(request.identity.supabaseUuid, id)
    return { queue_id: result.queueId, deduped: result.deduped }
  }

  @Put(":id/processing-mode")
  @ApiOperation({
    operationId: "adminSetSourceProcessingMode",
    summary: "Set one source processing mode",
  })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ schema: ADMIN_SOURCE_PROCESSING_MODE_BODY_SCHEMA })
  @ApiOkResponse({ type: AdminSourceDto })
  setProcessingMode(
    @Param("id") rawId: string,
    @Body() body: unknown,
    @Req() request: AdminRequest
  ): Promise<AdminSourceDto> {
    const id = parseAdminSourceId(rawId)
    const mode = parseAdminSourceProcessingModeBody(body)
    return this.admin.setProcessingMode(request.identity.supabaseUuid, id, mode)
  }

  @Post("bulk-processing-mode")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: "adminBulkSetSourceProcessingMode",
    summary: "Set every source processing mode",
  })
  @ApiBody({ schema: ADMIN_SOURCE_PROCESSING_MODE_BODY_SCHEMA })
  @ApiOkResponse({ type: AdminSourceMutationResultDto })
  async bulkSetProcessingMode(
    @Body() body: unknown,
    @Req() request: AdminRequest
  ): Promise<AdminSourceMutationResultDto> {
    const mode = parseAdminSourceProcessingModeBody(body)
    await this.admin.bulkSetProcessingMode(request.identity.supabaseUuid, mode)
    return { ok: true }
  }
}
