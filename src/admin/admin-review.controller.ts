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
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger"

import { ClerkAuthGuard } from "../auth/clerk.guard.js"
import { MappedIdentityGuard, type IdentifiedRequest } from "../auth/mapped-identity.guard.js"
import { OperatorGuard } from "../auth/operator.guard.js"
import {
  ADMIN_BULK_DELETE_BODY_SCHEMA,
  ADMIN_BULK_STATUS_BODY_SCHEMA,
  ADMIN_STATUS_BODY_SCHEMA,
  AdminErrorDto,
  AdminEventsPageDto,
  AdminEventsQueryDto,
  AdminFacetDto,
  AdminFacetsQueryDto,
  AdminMutationResultDto,
  AdminStatusResultDto,
  AdminValidationErrorDto,
} from "./admin-review.dto.js"
import {
  parseAdminBulkDeleteBody,
  parseAdminBulkStatusBody,
  parseAdminEventId,
  parseAdminEventsQuery,
  parseAdminFacetsQuery,
  parseAdminStatusBody,
} from "./admin-review.input.js"
import { AdminReviewService } from "./admin-review.service.js"

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
  description: "The mapped user is not an operator, or the event does not exist",
})
@ApiBadRequestResponse({
  type: AdminValidationErrorDto,
  description: "Invalid path, query parameters, or request body",
})
@UseGuards(ClerkAuthGuard, MappedIdentityGuard, OperatorGuard)
@Controller("v1/admin")
export class AdminReviewController {
  constructor(private readonly admin: AdminReviewService) {}

  @Get("events")
  @ApiOperation({ operationId: "adminListEvents", summary: "List the admin review queue" })
  @ApiQuery({ type: AdminEventsQueryDto })
  @ApiOkResponse({ type: AdminEventsPageDto })
  async listEvents(
    @Query() query: Record<string, unknown>,
    @Req() request: AdminRequest
  ): Promise<AdminEventsPageDto> {
    const input = parseAdminEventsQuery(query)
    const page = await this.admin.listEvents(request.identity.supabaseUuid, input)
    return {
      events: page.events.map((event) => ({
        id: event.id,
        title: event.title,
        status: event.status,
        start_datetime: event.start_datetime,
        venue_name: event.venue_name,
        city_id: event.city_id,
        source_id: event.source_id,
        source_name: event.source_name,
        is_free: event.is_free,
        age_min: event.age_min,
        age_max: event.age_max,
        ai_confidence: event.ai_confidence,
        llm_review_status: event.llm_review_status,
        llm_review_decision: event.llm_review_decision,
        llm_review_reason: event.llm_review_reason,
        llm_review_error: event.llm_review_error,
        created_at: event.created_at,
      })),
      total_count: page.totalCount,
      next_cursor:
        page.nextCursor === null
          ? null
          : {
              after_created_at: page.nextCursor.afterCreatedAt,
              after_id: page.nextCursor.afterId,
            },
    }
  }

  @Get("events/facets")
  @ApiOperation({ operationId: "adminEventFacets", summary: "List review queue facet counts" })
  @ApiQuery({ type: AdminFacetsQueryDto })
  @ApiOkResponse({ type: [AdminFacetDto] })
  async facets(
    @Query() query: Record<string, unknown>,
    @Req() request: AdminRequest
  ): Promise<AdminFacetDto[]> {
    const input = parseAdminFacetsQuery(query)
    const rows = await this.admin.facets(request.identity.supabaseUuid, input.keyword)
    return rows.map((row) => ({
      city_id: row.city_id,
      source_id: row.source_id,
      status: row.status,
      count: row.count,
    }))
  }

  @Put("events/:id/status")
  @ApiOperation({ operationId: "adminSetEventStatus", summary: "Set one event's review status" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ schema: ADMIN_STATUS_BODY_SCHEMA })
  @ApiOkResponse({ type: AdminStatusResultDto })
  async setStatus(
    @Param("id") rawId: string,
    @Body() body: unknown,
    @Req() request: AdminRequest
  ): Promise<AdminStatusResultDto> {
    const id = parseAdminEventId(rawId)
    const input = parseAdminStatusBody(body)
    await this.admin.setStatus(request.identity.supabaseUuid, id, input.status, input.reason)
    return { ok: true, affected: 1 }
  }

  @Post("events/bulk-status")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: "adminBulkEventStatus",
    summary: "Set review status for up to 500 submitted events",
  })
  @ApiBody({ schema: ADMIN_BULK_STATUS_BODY_SCHEMA })
  @ApiOkResponse({ type: AdminMutationResultDto })
  async bulkStatus(
    @Body() body: unknown,
    @Req() request: AdminRequest
  ): Promise<AdminMutationResultDto> {
    const input = parseAdminBulkStatusBody(body)
    return {
      ok: true,
      affected: await this.admin.bulkStatus(
        request.identity.supabaseUuid,
        input.eventIds,
        input.status
      ),
    }
  }

  @Post("events/bulk-delete")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: "adminBulkDeleteEvents",
    summary: "Delete up to 500 submitted review queue events",
  })
  @ApiBody({ schema: ADMIN_BULK_DELETE_BODY_SCHEMA })
  @ApiOkResponse({ type: AdminMutationResultDto })
  async bulkDelete(
    @Body() body: unknown,
    @Req() request: AdminRequest
  ): Promise<AdminMutationResultDto> {
    const input = parseAdminBulkDeleteBody(body)
    return {
      ok: true,
      affected: await this.admin.bulkDelete(request.identity.supabaseUuid, input.eventIds),
    }
  }
}
