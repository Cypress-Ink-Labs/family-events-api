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
