import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
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
import { SavedEventsDto } from "./saved-events.dto.js"
import { SavedEventsService } from "./saved-events.service.js"
import { OkResponseDto } from "./consumer-write.dto.js"
import { parseWriteId } from "./consumer-write.input.js"

@ApiTags("consumer")
@ApiBearerAuth("clerk")
@ApiUnauthorizedResponse({ description: "A valid Clerk bearer token is required" })
@ApiForbiddenResponse({ description: "Enabled account access is required" })
@ApiBadRequestResponse({ description: "Invalid saved-event request" })
@UseGuards(ClerkAuthGuard, MappedIdentityGuard)
@Controller("v1/me/saved-events")
export class SavedEventsController {
  constructor(private readonly saved: SavedEventsService) {}

  @Get()
  @ApiOperation({
    operationId: "getMySavedEvents",
    summary: "List the current user's saved ideas and calendar plans, including past saves",
  })
  @ApiOkResponse({ type: SavedEventsDto })
  list(
    @Req() request: IdentifiedRequest,
    @Query() query: Record<string, unknown>
  ): Promise<SavedEventsDto> {
    if (Object.keys(query).length)
      throw new BadRequestException("Account selectors are not accepted")
    return this.saved.list(request.identity.supabaseUuid)
  }

  @Delete(":id")
  @ApiOperation({
    operationId: "removeMySavedEvent",
    summary: "Remove the current user's favorite and calendar save together",
  })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ type: OkResponseDto })
  remove(
    @Req() request: IdentifiedRequest,
    @Param("id") id: string,
    @Query() query: Record<string, unknown>,
    @Body() body: unknown
  ): Promise<OkResponseDto> {
    if (
      Object.keys(query).length ||
      (body !== undefined &&
        (typeof body !== "object" || body === null || Object.keys(body).length))
    )
      throw new BadRequestException("Account selectors are not accepted")
    return this.saved.remove(request.identity.supabaseUuid, parseWriteId(id))
  }
}
