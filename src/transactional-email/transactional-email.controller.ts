import { Body, Controller, Get, Req, UseGuards, Param, Post, HttpCode } from "@nestjs/common"
import {
  ApiBearerAuth,
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiBody,
  ApiParam,
  ApiUnauthorizedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiConflictResponse,
  ApiServiceUnavailableResponse,
} from "@nestjs/swagger"
import { AdminInviteMutationDto } from "../admin/admin-invite.dto.js"
import { AdminErrorDto } from "../admin/admin-review.dto.js"
import { InviteDeliveryDto, InviteDeliveryReadinessDto } from "./transactional-email.dto.js"
import {
  parseAdminApproveInviteRequestBody,
  parseAdminInviteCodeId,
} from "../admin/admin-invite.input.js"
import { ClerkAuthGuard } from "../auth/clerk.guard.js"
import { MappedIdentityGuard, type IdentifiedRequest } from "../auth/mapped-identity.guard.js"
import { OperatorGuard } from "../auth/operator.guard.js"
import { TransactionalEmailService } from "./transactional-email.service.js"

@ApiTags("admin")
@ApiBearerAuth("clerk")
@ApiUnauthorizedResponse({ type: AdminErrorDto })
@ApiForbiddenResponse({ type: AdminErrorDto })
@ApiNotFoundResponse({ type: AdminErrorDto })
@ApiServiceUnavailableResponse({ type: AdminErrorDto })
@Controller("v1/admin/invite-deliveries")
@UseGuards(ClerkAuthGuard, MappedIdentityGuard, OperatorGuard)
export class TransactionalEmailController {
  constructor(private readonly deliveries: TransactionalEmailService) {}
  @Get("status")
  @ApiOperation({
    operationId: "adminGetInviteDeliveryReadiness",
    summary: "Get transactional email configuration readiness",
  })
  @ApiOkResponse({ type: InviteDeliveryReadinessDto })
  readiness(@Req() request: IdentifiedRequest) {
    return this.deliveries.readiness(request.identity.supabaseUuid)
  }
  @Post(":id/retry")
  @HttpCode(200)
  @ApiOperation({
    operationId: "adminRetryInviteDelivery",
    summary: "Retry an invitation delivery with its original provider key and body",
  })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ schema: { type: "object", additionalProperties: false }, required: false })
  @ApiOkResponse({ type: AdminInviteMutationDto })
  @ApiConflictResponse({
    type: AdminErrorDto,
    description: "Attempts older than 23 hours require operator reconciliation.",
  })
  retry(@Param("id") id: string, @Body() body: unknown, @Req() request: IdentifiedRequest) {
    parseAdminApproveInviteRequestBody(body)
    return this.deliveries.retry(request.identity.supabaseUuid, parseAdminInviteCodeId(id))
  }
  @Get()
  @ApiOperation({
    operationId: "adminListInviteDeliveries",
    summary: "List the latest 100 transactional delivery outcomes without message contents",
  })
  @ApiOkResponse({ type: [InviteDeliveryDto] })
  list(@Req() request: IdentifiedRequest) {
    return this.deliveries.list(request.identity.supabaseUuid)
  }
}
