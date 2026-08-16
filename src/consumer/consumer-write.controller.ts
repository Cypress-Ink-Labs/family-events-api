import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
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
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger"

import { ClerkAuthGuard } from "../auth/clerk.guard.js"
import { MappedIdentityGuard, type IdentifiedRequest } from "../auth/mapped-identity.guard.js"
import { PreferredCitiesValidationError } from "../data/preferred-cities.repository.js"
import { SubmissionLimitError } from "../data/submissions.repository.js"
import {
  CommentInputDto,
  CommunityEventInputDto,
  IdResponseDto,
  OkResponseDto,
  PreferredCitiesInputDto,
  PreferredCityDto,
  RatingInputDto,
  RatingResponseDto,
  RemovedResponseDto,
  ToggleInputDto,
} from "./consumer-write.dto.js"
import {
  parseCommentInput,
  parseCommunityEventInput,
  parsePreferredCitiesInput,
  parseRatingInput,
  parseToggleInput,
  parseWriteId,
} from "./consumer-write.input.js"
import { ConsumerWriteService } from "./consumer-write.service.js"

type ConsumerWriteRequest = Pick<IdentifiedRequest, "identity">

@ApiTags("consumer")
@ApiBearerAuth("clerk")
@ApiUnauthorizedResponse({ description: "A valid Clerk bearer token is required" })
@ApiForbiddenResponse({ description: "The Clerk user is not provisioned" })
@ApiBadRequestResponse({ description: "Invalid path or request body" })
@UseGuards(ClerkAuthGuard, MappedIdentityGuard)
@Controller("v1")
export class ConsumerWriteController {
  constructor(private readonly consumer: ConsumerWriteService) {}

  @Put("events/:id/favorite")
  @ApiOperation({ summary: "Set favorite state for an event" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ type: ToggleInputDto })
  @ApiOkResponse({ type: OkResponseDto })
  setFavorite(
    @Param("id") rawId: string,
    @Body() body: unknown,
    @Req() request: ConsumerWriteRequest
  ): Promise<OkResponseDto> {
    const input = parseToggleInput(body)
    return this.consumer.setFavorite(request.identity.supabaseUuid, parseWriteId(rawId), input.on)
  }

  @Put("events/:id/calendar")
  @ApiOperation({ summary: "Set calendar state for an event" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ type: ToggleInputDto })
  @ApiOkResponse({ type: OkResponseDto })
  setCalendar(
    @Param("id") rawId: string,
    @Body() body: unknown,
    @Req() request: ConsumerWriteRequest
  ): Promise<OkResponseDto> {
    const input = parseToggleInput(body)
    return this.consumer.setCalendar(request.identity.supabaseUuid, parseWriteId(rawId), input.on)
  }

  @Put("events/:id/rating")
  @ApiOperation({ summary: "Upsert the current user's event rating" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ type: RatingInputDto })
  @ApiOkResponse({ type: RatingResponseDto })
  rateEvent(
    @Param("id") rawId: string,
    @Body() body: unknown,
    @Req() request: ConsumerWriteRequest
  ): Promise<RatingResponseDto> {
    const input = parseRatingInput(body)
    return this.consumer.rateEvent(request.identity.supabaseUuid, parseWriteId(rawId), input.score)
  }

  @Post("events/:id/comments")
  @ApiOperation({ summary: "Post a comment on an event" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ type: CommentInputDto })
  @ApiCreatedResponse({ type: IdResponseDto })
  postComment(
    @Param("id") rawId: string,
    @Body() body: unknown,
    @Req() request: ConsumerWriteRequest
  ): Promise<IdResponseDto> {
    const input = parseCommentInput(body)
    return this.consumer.postComment(request.identity.supabaseUuid, parseWriteId(rawId), input.body)
  }

  @Delete("comments/:id")
  @ApiOperation({ summary: "Remove the current user's comment" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ type: RemovedResponseDto })
  removeComment(
    @Param("id") rawId: string,
    @Req() request: ConsumerWriteRequest
  ): Promise<RemovedResponseDto> {
    return this.consumer.removeComment(request.identity.supabaseUuid, parseWriteId(rawId))
  }

  @Post("events")
  @ApiOperation({ summary: "Submit a community event for moderation" })
  @ApiBody({ type: CommunityEventInputDto })
  @ApiCreatedResponse({ type: IdResponseDto })
  @ApiTooManyRequestsResponse({ description: "Daily community submission limit reached" })
  submitEvent(@Body() body: unknown, @Req() request: ConsumerWriteRequest): Promise<IdResponseDto> {
    const input = parseCommunityEventInput(body)
    return this.consumer
      .submitEvent(request.identity.supabaseUuid, input)
      .catch((error: unknown) => {
        if (error instanceof SubmissionLimitError) {
          throw new HttpException(error.message, HttpStatus.TOO_MANY_REQUESTS)
        }
        throw error
      })
  }

  @Put("me/preferred-cities")
  @ApiOperation({ summary: "Replace the current user's preferred cities" })
  @ApiBody({ type: PreferredCitiesInputDto })
  @ApiOkResponse({ type: OkResponseDto })
  setPreferredCities(
    @Body() body: unknown,
    @Req() request: ConsumerWriteRequest
  ): Promise<OkResponseDto> {
    const input = parsePreferredCitiesInput(body)
    return this.consumer
      .setPreferredCities(request.identity.supabaseUuid, input.city_ids, input.primary_city_id)
      .catch((error: unknown) => {
        if (error instanceof PreferredCitiesValidationError) {
          throw new BadRequestException(error.message)
        }
        throw error
      })
  }

  @Get("me/preferred-cities")
  @ApiOperation({ summary: "List the current user's preferred cities" })
  @ApiOkResponse({ type: [PreferredCityDto] })
  listPreferredCities(@Req() request: ConsumerWriteRequest): Promise<PreferredCityDto[]> {
    return this.consumer.listPreferredCities(request.identity.supabaseUuid)
  }
}
