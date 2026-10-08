import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
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
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger"
import { ClerkAuthGuard } from "../auth/clerk.guard.js"
import { MappedIdentityGuard, type IdentifiedRequest } from "../auth/mapped-identity.guard.js"
import {
  BrowserSubscriptionDto,
  BrowserSubscriptionInputDto,
  NotificationPreferencesUpdateDto,
  NotificationSettingsDto,
} from "./notification-preferences.dto.js"
import {
  parseBrowserSubscription,
  parseNotificationPreferences,
} from "./notification-preferences.input.js"
import { parseWriteId } from "./consumer-write.input.js"
import { NotificationPreferencesService } from "./notification-preferences.service.js"

@ApiTags("consumer")
@ApiBearerAuth("clerk")
@ApiUnauthorizedResponse({ description: "A valid Clerk bearer token is required" })
@ApiForbiddenResponse({ description: "Enabled account access is required" })
@ApiBadRequestResponse({ description: "Invalid notification settings request" })
@UseGuards(ClerkAuthGuard, MappedIdentityGuard)
@Controller("v1/me")
export class NotificationPreferencesController {
  constructor(private readonly settings: NotificationPreferencesService) {}

  @Get("notification-preferences")
  @ApiOperation({
    operationId: "getMyNotificationSettings",
    summary: "Read saved notification preferences and actual channel capabilities",
  })
  @ApiOkResponse({ type: NotificationSettingsDto })
  get(
    @Req() request: IdentifiedRequest,
    @Query() query: Record<string, unknown>
  ): Promise<NotificationSettingsDto> {
    if (Object.keys(query).length)
      throw new BadRequestException("Account selectors are not accepted")
    return this.settings.get(request.identity.supabaseUuid)
  }

  @Put("notification-preferences")
  @ApiOperation({
    operationId: "updateMyNotificationPreferences",
    summary: "Patch owned preferences, requiring browser registration when enabling push",
  })
  @ApiBody({ type: NotificationPreferencesUpdateDto })
  @ApiOkResponse({ type: NotificationSettingsDto })
  update(
    @Req() request: IdentifiedRequest,
    @Body() body: unknown,
    @Query() query: Record<string, unknown>
  ): Promise<NotificationSettingsDto> {
    this.rejectQuery(query)
    return this.settings.update(request.identity.supabaseUuid, parseNotificationPreferences(body))
  }

  @Post("push-subscriptions")
  @ApiOperation({
    operationId: "registerMyBrowserSubscription",
    summary: "Register actual browser Web Push keys under the current account",
  })
  @ApiBody({ type: BrowserSubscriptionInputDto })
  @ApiCreatedResponse({ type: BrowserSubscriptionDto })
  register(
    @Req() request: IdentifiedRequest,
    @Body() body: unknown,
    @Query() query: Record<string, unknown>
  ): Promise<BrowserSubscriptionDto> {
    this.rejectQuery(query)
    return this.settings.register(request.identity.supabaseUuid, parseBrowserSubscription(body))
  }

  @Delete("push-subscriptions/:id")
  @ApiOperation({
    operationId: "removeMyBrowserSubscription",
    summary: "Remove one owned browser subscription",
  })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ type: NotificationSettingsDto })
  remove(
    @Req() request: IdentifiedRequest,
    @Param("id") id: string,
    @Query() query: Record<string, unknown>
  ): Promise<NotificationSettingsDto> {
    this.rejectQuery(query)
    return this.settings.remove(request.identity.supabaseUuid, parseWriteId(id))
  }

  private rejectQuery(query: Record<string, unknown>): void {
    if (Object.keys(query).length)
      throw new BadRequestException("Account selectors are not accepted")
  }
}
