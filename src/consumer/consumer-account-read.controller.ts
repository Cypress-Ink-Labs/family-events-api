import { Controller, Get, Req, UseGuards } from "@nestjs/common"
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger"

import { ClerkAuthGuard } from "../auth/clerk.guard.js"
import { MappedIdentityGuard, type IdentifiedRequest } from "../auth/mapped-identity.guard.js"
import { CalendarEventsDto, FavoriteEventsDto } from "./consumer.dto.js"
import { ConsumerService } from "./consumer.service.js"

type ConsumerReadRequest = Pick<IdentifiedRequest, "identity">

@ApiTags("consumer")
@ApiBearerAuth("clerk")
@ApiUnauthorizedResponse({ description: "A valid Clerk bearer token is required" })
@ApiForbiddenResponse({ description: "The Clerk user is not provisioned" })
@UseGuards(ClerkAuthGuard, MappedIdentityGuard)
@Controller("v1/me")
export class ConsumerAccountReadController {
  constructor(private readonly consumer: ConsumerService) {}

  @Get("favorites")
  @ApiOperation({ summary: "List the current user's favorite events" })
  @ApiOkResponse({ type: FavoriteEventsDto })
  async listFavorites(@Req() request: ConsumerReadRequest): Promise<FavoriteEventsDto> {
    return {
      events: await this.consumer.listFavoriteEvents(request.identity.supabaseUuid),
    }
  }

  @Get("calendar")
  @ApiOperation({ summary: "List the current user's calendar entries" })
  @ApiOkResponse({ type: CalendarEventsDto })
  async listCalendar(@Req() request: ConsumerReadRequest): Promise<CalendarEventsDto> {
    return {
      entries: await this.consumer.listCalendarEvents(request.identity.supabaseUuid),
    }
  }
}
