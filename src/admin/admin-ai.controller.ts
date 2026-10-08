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
  ApiBody,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger"
import { z } from "zod"
import { ClerkAuthGuard } from "../auth/clerk.guard.js"
import { MappedIdentityGuard, type IdentifiedRequest } from "../auth/mapped-identity.guard.js"
import { OperatorGuard } from "../auth/operator.guard.js"
import {
  AdminAiSettingsDto,
  AdminAiFeatureDto,
  AdminAiUpdateDto,
  AdminDashboardHealthDto,
} from "./admin-ai.dto.js"
import { AdminAiRepository } from "./admin-ai.repository.js"

const featureSchema = z.enum([
  "tagging",
  "event-review",
  "parent-tips",
  "tag-memory",
  "review-memory",
  "source-auto-reject",
])
const updateSchema = z.strictObject({
  model_id: z.string().trim().min(1).max(200),
  enabled: z.boolean(),
})
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new BadRequestException("invalid AI setting request")
  return parsed.data
}
@ApiTags("admin")
@ApiBearerAuth("clerk")
@ApiUnauthorizedResponse({ description: "Verified session required" })
@ApiForbiddenResponse({ description: "Database admin access required" })
@ApiNotFoundResponse({ description: "Operator access required" })
@ApiBadRequestResponse({ description: "Invalid AI setting request" })
@UseGuards(ClerkAuthGuard, MappedIdentityGuard, OperatorGuard)
@Controller("v1/admin")
export class AdminAiController {
  constructor(private readonly ai: AdminAiRepository) {}
  @Get("ai")
  @ApiOkResponse({ type: AdminAiSettingsDto })
  settings(@Query() query: Record<string, unknown>, @Req() request: IdentifiedRequest) {
    parse(z.strictObject({}), query)
    return this.ai.settings(request.identity.supabaseUuid)
  }
  @Put("ai/features/:feature")
  @ApiParam({ name: "feature", enum: featureSchema.options })
  @ApiBody({ type: AdminAiUpdateDto })
  @ApiOkResponse({ type: AdminAiFeatureDto })
  update(
    @Param("feature") feature: string,
    @Body() body: unknown,
    @Req() request: IdentifiedRequest
  ) {
    return this.ai.update(
      request.identity.supabaseUuid,
      parse(featureSchema, feature),
      parse(updateSchema, body)
    )
  }
  @Get("dashboard/health")
  @ApiOkResponse({ type: AdminDashboardHealthDto })
  health(@Query() query: Record<string, unknown>, @Req() request: IdentifiedRequest) {
    parse(z.strictObject({}), query)
    return this.ai.health(request.identity.supabaseUuid)
  }
}
