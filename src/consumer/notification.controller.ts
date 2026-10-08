import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common"
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger"
import { ClerkAuthGuard } from "../auth/clerk.guard.js"
import { MappedIdentityGuard, type IdentifiedRequest } from "../auth/mapped-identity.guard.js"
import { NotificationInboxRepository } from "../data/notification-inbox.repository.js"
import { parseWriteId } from "./consumer-write.input.js"
import { NotificationInboxDto } from "./notification.dto.js"

@ApiTags("consumer")
@ApiBearerAuth("clerk")
@ApiUnauthorizedResponse({ description: "A valid Clerk bearer token is required" })
@ApiForbiddenResponse({ description: "Enabled account access is required" })
@ApiBadRequestResponse({ description: "Invalid notification request" })
@UseGuards(ClerkAuthGuard, MappedIdentityGuard)
@Controller("v1/me/notifications")
export class NotificationController {
  constructor(private readonly inbox: NotificationInboxRepository) {}

  @Get()
  @ApiOperation({
    operationId: "getMyNotifications",
    summary: "List the latest 20 notifications and all unread count",
  })
  @ApiOkResponse({ type: NotificationInboxDto })
  get(
    @Req() request: IdentifiedRequest,
    @Query() query: Record<string, unknown>
  ): Promise<NotificationInboxDto> {
    this.rejectExtra(query)
    return this.inbox.get(request.identity.supabaseUuid)
  }

  @Put("read")
  @ApiOperation({
    operationId: "markAllMyNotificationsRead",
    summary: "Mark all of the current user's notifications read",
  })
  @ApiOkResponse({ type: NotificationInboxDto })
  markAll(
    @Req() request: IdentifiedRequest,
    @Body() body: unknown,
    @Query() query: Record<string, unknown>
  ): Promise<NotificationInboxDto> {
    this.rejectExtra(query, body)
    return this.inbox.markAllRead(request.identity.supabaseUuid)
  }

  @Put(":id/read")
  @ApiOperation({
    operationId: "markMyNotificationRead",
    summary: "Mark one owned notification read",
  })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ type: NotificationInboxDto })
  markOne(
    @Req() request: IdentifiedRequest,
    @Param("id") id: string,
    @Body() body: unknown,
    @Query() query: Record<string, unknown>
  ): Promise<NotificationInboxDto> {
    this.rejectExtra(query, body)
    return this.inbox.markRead(request.identity.supabaseUuid, parseWriteId(id))
  }

  private rejectExtra(query: Record<string, unknown>, body?: unknown): void {
    if (
      Object.keys(query).length ||
      (body !== undefined &&
        body !== null &&
        (typeof body !== "object" || Array.isArray(body) || Object.keys(body).length))
    )
      throw new BadRequestException(
        "Notification requests do not accept account selectors or a body"
      )
  }
}
