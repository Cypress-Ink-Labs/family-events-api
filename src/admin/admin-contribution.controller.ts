import { Body, Controller, Delete, Get, Param, Put, Query, Req, UseGuards } from "@nestjs/common"
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger"
import { ClerkAuthGuard } from "../auth/clerk.guard.js"
import { MappedIdentityGuard, type IdentifiedRequest } from "../auth/mapped-identity.guard.js"
import { OperatorGuard } from "../auth/operator.guard.js"
import {
  AdminCommentPageDto,
  AdminRatingPageDto,
  AdminCommentUpdateDto,
} from "./admin-contribution.dto.js"
import {
  parseCommentPage,
  parseRatingPage,
  parseCommentUpdate,
  parseContributionId,
} from "./admin-contribution.input.js"
import { AdminContributionRepository } from "./admin-contribution.repository.js"

@ApiTags("admin")
@ApiBearerAuth("clerk")
@ApiUnauthorizedResponse({ description: "Verified Clerk session required" })
@ApiForbiddenResponse({ description: "Database admin access required" })
@ApiNotFoundResponse({ description: "Non-operator or missing contribution" })
@ApiBadRequestResponse({ description: "Invalid contribution request" })
@UseGuards(ClerkAuthGuard, MappedIdentityGuard, OperatorGuard)
@Controller("v1/admin")
export class AdminContributionController {
  constructor(private readonly contributions: AdminContributionRepository) {}
  @Get("comments")
  @ApiQuery({ name: "page", required: false, type: Number, minimum: 0 })
  @ApiQuery({ name: "filter", required: false, enum: ["all", "pending", "flagged", "approved"] })
  @ApiOkResponse({ type: AdminCommentPageDto })
  comments(@Query() query: Record<string, unknown>, @Req() request: IdentifiedRequest) {
    const input = parseCommentPage(query)
    return this.contributions.comments(request.identity.supabaseUuid, input.page, input.filter)
  }
  @Get("ratings")
  @ApiQuery({ name: "page", required: false, type: Number, minimum: 0 })
  @ApiOkResponse({ type: AdminRatingPageDto })
  ratings(@Query() query: Record<string, unknown>, @Req() request: IdentifiedRequest) {
    return this.contributions.ratings(request.identity.supabaseUuid, parseRatingPage(query).page)
  }
  @Put("comments/:id")
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ type: AdminCommentUpdateDto })
  @ApiOkResponse({
    schema: { type: "object", required: ["updated"], properties: { updated: { type: "boolean" } } },
  })
  update(@Param("id") id: string, @Body() body: unknown, @Req() request: IdentifiedRequest) {
    return this.contributions.update(
      request.identity.supabaseUuid,
      parseContributionId(id),
      parseCommentUpdate(body)
    )
  }
  @Delete("comments/:id")
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({
    schema: { type: "object", required: ["removed"], properties: { removed: { type: "boolean" } } },
  })
  removeComment(@Param("id") id: string, @Req() request: IdentifiedRequest) {
    return this.contributions.remove(
      request.identity.supabaseUuid,
      "comment",
      parseContributionId(id)
    )
  }
  @Delete("ratings/:id")
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({
    schema: { type: "object", required: ["removed"], properties: { removed: { type: "boolean" } } },
  })
  removeRating(@Param("id") id: string, @Req() request: IdentifiedRequest) {
    return this.contributions.remove(
      request.identity.supabaseUuid,
      "rating",
      parseContributionId(id)
    )
  }
}
