import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
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
import {
  ADMIN_EVENT_UPDATE_BODY_SCHEMA,
  AdminEventEditorDetailDto,
} from "./admin-event-editor.dto.js"
import { parseAdminUnlockEventBody, parseAdminUpdateEventBody } from "./admin-event-editor.input.js"
import type { AdminEventEditorDetail } from "./admin-event-editor.repository.js"
import { AdminEventEditorService } from "./admin-event-editor.service.js"
import { AdminErrorDto, AdminStatusResultDto, AdminValidationErrorDto } from "./admin-review.dto.js"
import { parseAdminEventId } from "./admin-review.input.js"

type AdminRequest = Pick<IdentifiedRequest, "identity">

function toDto(detail: AdminEventEditorDetail): AdminEventEditorDetailDto {
  return {
    event: detail.event,
    tags: detail.tags,
    available_tags: detail.availableTags,
  }
}

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
  description: "Invalid event ID or request body",
})
@UseGuards(ClerkAuthGuard, MappedIdentityGuard, OperatorGuard)
@Controller("v1/admin/events")
export class AdminEventEditorController {
  constructor(private readonly admin: AdminEventEditorService) {}

  @Get(":id")
  @ApiOperation({ operationId: "adminGetEvent", summary: "Fetch one event for editing" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ type: AdminEventEditorDetailDto })
  async get(
    @Param("id") rawId: string,
    @Req() request: AdminRequest
  ): Promise<AdminEventEditorDetailDto> {
    const detail = await this.admin.get(request.identity.supabaseUuid, parseAdminEventId(rawId))
    return toDto(detail)
  }

  @Put(":id")
  @ApiOperation({ operationId: "adminUpdateEvent", summary: "Update one event and its tags" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ schema: ADMIN_EVENT_UPDATE_BODY_SCHEMA })
  @ApiOkResponse({ type: AdminEventEditorDetailDto })
  async update(
    @Param("id") rawId: string,
    @Body() body: unknown,
    @Req() request: AdminRequest
  ): Promise<AdminEventEditorDetailDto> {
    const id = parseAdminEventId(rawId)
    const input = parseAdminUpdateEventBody(body)
    return toDto(await this.admin.update(request.identity.supabaseUuid, id, input))
  }

  @Post(":id/unlock")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: "adminUnlockEventFields",
    summary: "Unlock every admin-managed field on one event",
  })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ type: AdminStatusResultDto })
  async unlock(
    @Param("id") rawId: string,
    @Body() body: unknown,
    @Req() request: AdminRequest
  ): Promise<AdminStatusResultDto> {
    const id = parseAdminEventId(rawId)
    parseAdminUnlockEventBody(body)
    await this.admin.unlock(request.identity.supabaseUuid, id)
    return { ok: true, affected: 1 }
  }
}
