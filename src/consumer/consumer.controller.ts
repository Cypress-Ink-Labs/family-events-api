import { Controller, Get, NotFoundException, Param, Query, Req, UseGuards } from "@nestjs/common"
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger"

import {
  OptionalClerkAuthGuard,
  type OptionalIdentifiedRequest,
} from "../auth/optional-clerk.guard.js"
import {
  CityDto,
  EnrichedEventDto,
  EventDetailDto,
  EventsPageDto,
  EventsQueryDto,
  MapEventsDto,
  MapQueryDto,
  TagDto,
} from "./consumer.dto.js"
import { parseEventId, parseExploreQuery, parseMapQuery } from "./consumer.query.js"
import { ConsumerService } from "./consumer.service.js"

const OPTIONAL_CLERK_SECURITY: Record<string, string[]>[] = [{}, { clerk: [] }]

@ApiTags("consumer")
@ApiUnauthorizedResponse({ description: "The supplied bearer token is invalid" })
@UseGuards(OptionalClerkAuthGuard)
@Controller("v1")
export class ConsumerController {
  constructor(private readonly consumer: ConsumerService) {}

  @Get("cities")
  @ApiOperation({
    summary: "List active cities",
    security: OPTIONAL_CLERK_SECURITY,
  })
  @ApiOkResponse({ type: [CityDto] })
  listCities(): Promise<CityDto[]> {
    return this.consumer.listCities()
  }

  @Get("events")
  @ApiOperation({
    summary: "List and search events",
    security: OPTIONAL_CLERK_SECURITY,
  })
  @ApiQuery({ type: EventsQueryDto })
  @ApiOkResponse({ type: EventsPageDto })
  @ApiBadRequestResponse({ description: "Invalid query parameters or cursor" })
  listEvents(
    @Query() query: Record<string, unknown>,
    @Req() request: OptionalIdentifiedRequest
  ): Promise<EventsPageDto> {
    const input = parseExploreQuery(query)
    return this.consumer.listEvents(input, request.identity?.supabaseUuid ?? null)
  }

  @Get("events/map")
  @ApiOperation({
    summary: "List mappable events",
    security: OPTIONAL_CLERK_SECURITY,
  })
  @ApiQuery({ type: MapQueryDto })
  @ApiOkResponse({ type: MapEventsDto })
  @ApiBadRequestResponse({ description: "Invalid query parameters" })
  async listMapEvents(@Query() query: Record<string, unknown>): Promise<MapEventsDto> {
    const input = parseMapQuery(query)
    return { events: await this.consumer.listMapEvents(input.cityId) }
  }

  @Get("events/:id")
  @ApiOperation({
    summary: "Get an event",
    security: OPTIONAL_CLERK_SECURITY,
  })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ type: EnrichedEventDto })
  @ApiBadRequestResponse({ description: "Invalid event id" })
  @ApiNotFoundResponse({ description: "Event not found" })
  async getEvent(
    @Param("id") rawId: string,
    @Req() request: OptionalIdentifiedRequest
  ): Promise<EnrichedEventDto> {
    const event = await this.consumer.getEvent(
      parseEventId(rawId),
      request.identity?.supabaseUuid ?? null
    )
    if (event === null) throw new NotFoundException("event not found")
    return event
  }

  @Get("events/:id/detail")
  @ApiOperation({
    summary: "Get the consumer event-detail composite",
    security: OPTIONAL_CLERK_SECURITY,
  })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ type: EventDetailDto })
  @ApiBadRequestResponse({ description: "Invalid event id" })
  getEventDetail(
    @Param("id") rawId: string,
    @Req() request: OptionalIdentifiedRequest
  ): Promise<EventDetailDto> {
    return this.consumer.getEventDetail(parseEventId(rawId), request.identity?.supabaseUuid ?? null)
  }

  @Get("tags")
  @ApiOperation({
    summary: "List event tags",
    security: OPTIONAL_CLERK_SECURITY,
  })
  @ApiOkResponse({ type: [TagDto] })
  listTags(): Promise<TagDto[]> {
    return this.consumer.listTags()
  }
}
