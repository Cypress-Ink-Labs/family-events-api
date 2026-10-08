import {
  Body,
  Controller,
  Get,
  Put,
  Query,
  Req,
  UseGuards,
  BadRequestException,
} from "@nestjs/common"
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger"
import { ClerkAuthGuard } from "../auth/clerk.guard.js"
import { MappedIdentityGuard, type IdentifiedRequest } from "../auth/mapped-identity.guard.js"
import { ProfileRepository } from "../data/profile.repository.js"
import { ProfileUpdateDto, UserProfileDto } from "./profile.dto.js"
import { parseProfileUpdate } from "./profile.input.js"

@ApiTags("consumer")
@ApiBearerAuth("clerk")
@ApiUnauthorizedResponse({ description: "A verified Clerk session is required" })
@ApiForbiddenResponse({ description: "The user is not provisioned or has no active access" })
@ApiNotFoundResponse({ description: "Profile not found" })
@ApiBadRequestResponse({ description: "Invalid profile settings or query" })
@UseGuards(ClerkAuthGuard, MappedIdentityGuard)
@Controller("v1/me/profile")
export class ProfileController {
  constructor(private readonly profiles: ProfileRepository) {}

  @Get()
  @ApiOperation({ operationId: "getMyProfile", summary: "Read the current user's app settings" })
  @ApiOkResponse({ type: UserProfileDto })
  get(
    @Query() query: Record<string, unknown>,
    @Req() request: Pick<IdentifiedRequest, "identity">
  ): Promise<UserProfileDto> {
    if (Object.keys(query).length)
      throw new BadRequestException("Profile reads do not accept query parameters")
    return this.profiles.get(request.identity.supabaseUuid)
  }

  @Put()
  @ApiOperation({
    operationId: "updateMyProfile",
    summary: "Update the current user's app settings",
  })
  @ApiBody({ type: ProfileUpdateDto })
  @ApiOkResponse({ type: UserProfileDto })
  update(
    @Body() body: unknown,
    @Req() request: Pick<IdentifiedRequest, "identity">
  ): Promise<UserProfileDto> {
    return this.profiles.update(request.identity.supabaseUuid, parseProfileUpdate(body))
  }
}
