import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
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
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger"

import { ClerkAuthGuard } from "../auth/clerk.guard.js"
import { MappedIdentityGuard, type IdentifiedRequest } from "../auth/mapped-identity.guard.js"
import { OperatorGuard } from "../auth/operator.guard.js"
import { AdminErrorDto, AdminValidationErrorDto } from "./admin-review.dto.js"
import {
  AdminDeadLetterDeleteDto,
  AdminDeadLetterRetryDto,
  AdminDeadLettersPageDto,
} from "./admin-dead-letter.dto.js"
import {
  parseDeadLetterListQuery,
  parseDeadLetterPath,
  parseEmptyDeadLetterBody,
} from "./admin-dead-letter.input.js"
import { AdminDeadLetterService } from "./admin-dead-letter.service.js"

type AdminRequest = Pick<IdentifiedRequest, "identity">
const EMPTY_BODY_SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
}

@ApiTags("admin")
@ApiBearerAuth("clerk")
@ApiUnauthorizedResponse({ type: AdminErrorDto })
@ApiForbiddenResponse({ type: AdminErrorDto, description: "Admin access is not provisioned" })
@ApiNotFoundResponse({ type: AdminErrorDto, description: "Dead letter not found" })
@ApiBadRequestResponse({ type: AdminValidationErrorDto })
@UseGuards(ClerkAuthGuard, MappedIdentityGuard, OperatorGuard)
@Controller("v1/admin/dead-letters")
export class AdminDeadLetterController {
  constructor(private readonly service: AdminDeadLetterService) {}

  @Get()
  @ApiOperation({ operationId: "adminListDeadLetters", summary: "List legacy queue dead letters" })
  @ApiQuery({ name: "queue", required: true, enum: ["source", "tag"] })
  @ApiQuery({ name: "limit", required: false, type: Number, minimum: 1, maximum: 50 })
  @ApiQuery({
    name: "cursor",
    required: false,
    type: String,
    description: "Opaque base64url keyset cursor",
  })
  @ApiOkResponse({ type: AdminDeadLettersPageDto })
  async list(
    @Query() query: Record<string, unknown>,
    @Req() request: AdminRequest
  ): Promise<AdminDeadLettersPageDto> {
    const page = await this.service.list(
      request.identity.supabaseUuid,
      parseDeadLetterListQuery(query)
    )
    return { items: page.items, next_cursor: page.nextCursor }
  }

  @Post(":queue/:id/retry")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: "adminRetryDeadLetter",
    summary: "Retry one legacy queue dead letter",
  })
  @ApiParam({ name: "queue", enum: ["source", "tag"] })
  @ApiParam({ name: "id", schema: { type: "string", pattern: "^[1-9]\\d*$" } })
  @ApiBody({ required: false, schema: EMPTY_BODY_SCHEMA })
  @ApiOkResponse({ type: AdminDeadLetterRetryDto })
  async retry(
    @Param("queue") rawQueue: string,
    @Param("id") rawId: string,
    @Body() body: unknown,
    @Req() request: AdminRequest
  ): Promise<AdminDeadLetterRetryDto> {
    parseEmptyDeadLetterBody(body)
    const { queue, id } = parseDeadLetterPath(rawQueue, rawId)
    const result = await this.service.retry(request.identity.supabaseUuid, queue, id)
    return { status: result.disposition, resulting_queue_id: result.resultingQueueId }
  }

  @Delete(":queue/:id")
  @ApiOperation({
    operationId: "adminDeleteDeadLetter",
    summary: "Delete one legacy queue dead letter",
  })
  @ApiParam({ name: "queue", enum: ["source", "tag"] })
  @ApiParam({ name: "id", schema: { type: "string", pattern: "^[1-9]\\d*$" } })
  @ApiBody({ required: false, schema: EMPTY_BODY_SCHEMA })
  @ApiOkResponse({ type: AdminDeadLetterDeleteDto })
  async remove(
    @Param("queue") rawQueue: string,
    @Param("id") rawId: string,
    @Body() body: unknown,
    @Req() request: AdminRequest
  ): Promise<AdminDeadLetterDeleteDto> {
    parseEmptyDeadLetterBody(body)
    const { queue, id } = parseDeadLetterPath(rawQueue, rawId)
    await this.service.remove(request.identity.supabaseUuid, queue, id)
    return { ok: true }
  }
}
