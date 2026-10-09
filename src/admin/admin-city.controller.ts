import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from "@nestjs/common"
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger"
import { ClerkAuthGuard } from "../auth/clerk.guard.js"
import { MappedIdentityGuard, type IdentifiedRequest } from "../auth/mapped-identity.guard.js"
import { OperatorGuard } from "../auth/operator.guard.js"
import { AdminCityDto, AdminCreateCityDto, AdminCityActiveDto } from "./admin-city.dto.js"
import {
  parseAdminCreateCity,
  parseAdminCityActive,
  parseAdminCityId,
  parseAdminCityQuery,
} from "./admin-city.input.js"
import { AdminCityRepository } from "./admin-city.repository.js"

@ApiTags("admin")
@ApiBearerAuth("clerk")
@ApiUnauthorizedResponse({ description: "Verified Clerk session required" })
@ApiForbiddenResponse({ description: "Mapped account/database admin access required" })
@ApiNotFoundResponse({ description: "Non-operator or missing city" })
@ApiBadRequestResponse({ description: "Invalid city request" })
@UseGuards(ClerkAuthGuard, MappedIdentityGuard, OperatorGuard)
@Controller("v1/admin/cities")
export class AdminCityController {
  constructor(private readonly cities: AdminCityRepository) {}
  @Get()
  @ApiOperation({ summary: "List all cities, including inactive cities" })
  @ApiOkResponse({ type: [AdminCityDto] })
  list(@Query() query: Record<string, unknown>, @Req() request: IdentifiedRequest) {
    parseAdminCityQuery(query)
    return this.cities.list(request.identity.supabaseUuid)
  }
  @Post()
  @ApiOperation({ summary: "Create an active city with legacy location fields" })
  @ApiBody({ type: AdminCreateCityDto })
  @ApiCreatedResponse({ type: AdminCityDto })
  @ApiConflictResponse({ description: "record already exists" })
  create(@Body() body: unknown, @Req() request: IdentifiedRequest) {
    return this.cities.create(request.identity.supabaseUuid, parseAdminCreateCity(body))
  }
  @Put(":id/active")
  @ApiOperation({ summary: "Set city active state and audit the mapped actor" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ type: AdminCityActiveDto })
  @ApiOkResponse({ type: AdminCityDto })
  active(@Param("id") id: string, @Body() body: unknown, @Req() request: IdentifiedRequest) {
    return this.cities.setActive(
      request.identity.supabaseUuid,
      parseAdminCityId(id),
      parseAdminCityActive(body).is_active
    )
  }
}
