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
import {
  ADMIN_CREATE_INVITE_CODE_SCHEMA,
  ADMIN_REJECT_INVITE_REQUEST_SCHEMA,
  AdminApprovedInviteRequestDto,
  AdminCreatedInviteCodeDto,
  AdminInviteCodeDto,
  AdminInviteMutationDto,
  AdminInviteRequestDto,
  AdminInviteRequiredDto,
} from "./admin-invite.dto.js"
import {
  parseAdminCreateInviteCodeBody,
  parseAdminApproveInviteRequestBody,
  parseAdminInviteCodeId,
  parseAdminInviteQuery,
  parseAdminInviteRequestId,
  parseAdminInviteRequestQuery,
  parseAdminRejectInviteRequestBody,
  parseAdminRevokeInviteCodeBody,
} from "./admin-invite.input.js"
import { AdminInviteService } from "./admin-invite.service.js"
import { AdminErrorDto, AdminValidationErrorDto } from "./admin-review.dto.js"

type AdminRequest = Pick<IdentifiedRequest, "identity">

@ApiTags("admin")
@ApiBearerAuth("clerk")
@ApiUnauthorizedResponse({ type: AdminErrorDto })
@ApiForbiddenResponse({
  type: AdminErrorDto,
  description: "Database denial returns: admin access is not provisioned.",
})
@ApiNotFoundResponse({ type: AdminErrorDto })
@ApiBadRequestResponse({ type: AdminValidationErrorDto })
@UseGuards(ClerkAuthGuard, MappedIdentityGuard, OperatorGuard)
@Controller("v1/admin")
export class AdminInviteController {
  constructor(private readonly admin: AdminInviteService) {}

  @Get("invites/required")
  @ApiOperation({ operationId: "adminGetInvitesRequired", summary: "Get invite gate status" })
  @ApiOkResponse({ type: AdminInviteRequiredDto })
  async required(@Query() query: Record<string, unknown>, @Req() request: AdminRequest) {
    parseAdminInviteQuery(query)
    return { required: await this.admin.required(request.identity.supabaseUuid) }
  }

  @Get("invite-codes")
  @ApiOperation({ operationId: "adminListInviteCodes", summary: "List invite code metadata" })
  @ApiOkResponse({ type: [AdminInviteCodeDto] })
  list(@Query() query: Record<string, unknown>, @Req() request: AdminRequest) {
    parseAdminInviteQuery(query)
    return this.admin.listCodes(request.identity.supabaseUuid)
  }

  @Post("invite-codes")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: "adminCreateInviteCode",
    summary: "Create an invite code (plaintext returned once)",
  })
  @ApiBody({ schema: ADMIN_CREATE_INVITE_CODE_SCHEMA })
  @ApiOkResponse({ type: AdminCreatedInviteCodeDto })
  create(@Body() body: unknown, @Req() request: AdminRequest) {
    return this.admin.createCode(
      request.identity.supabaseUuid,
      parseAdminCreateInviteCodeBody(body)
    )
  }

  @Delete("invite-codes/:id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ operationId: "adminRevokeInviteCode", summary: "Revoke an invite code" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ type: AdminInviteMutationDto })
  async revoke(@Param("id") rawId: string, @Body() body: unknown, @Req() request: AdminRequest) {
    const id = parseAdminInviteCodeId(rawId)
    parseAdminRevokeInviteCodeBody(body)
    await this.admin.revokeCode(request.identity.supabaseUuid, id)
    return { ok: true as const }
  }

  @Get("invite-requests")
  @ApiOperation({ operationId: "adminListInviteRequests", summary: "List invite requests" })
  @ApiQuery({
    name: "status",
    required: false,
    enum: ["pending", "approved", "rejected", "all"],
  })
  @ApiOkResponse({ type: [AdminInviteRequestDto] })
  listRequests(@Query() query: Record<string, unknown>, @Req() request: AdminRequest) {
    return this.admin.listRequests(
      request.identity.supabaseUuid,
      parseAdminInviteRequestQuery(query)
    )
  }

  @Post("invite-requests/:id/approve")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: "adminApproveInviteRequest",
    summary: "Approve an invite request (plaintext returned once)",
  })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ schema: { type: "object", additionalProperties: false }, required: false })
  @ApiOkResponse({ type: AdminApprovedInviteRequestDto })
  approveRequest(@Param("id") rawId: string, @Body() body: unknown, @Req() request: AdminRequest) {
    const id = parseAdminInviteRequestId(rawId)
    parseAdminApproveInviteRequestBody(body)
    return this.admin.approveRequest(request.identity.supabaseUuid, id)
  }

  @Post("invite-requests/:id/reject")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ operationId: "adminRejectInviteRequest", summary: "Reject an invite request" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ schema: ADMIN_REJECT_INVITE_REQUEST_SCHEMA, required: false })
  @ApiOkResponse({ type: AdminInviteMutationDto })
  async rejectRequest(
    @Param("id") rawId: string,
    @Body() body: unknown,
    @Req() request: AdminRequest
  ) {
    const id = parseAdminInviteRequestId(rawId)
    const input = parseAdminRejectInviteRequestBody(body)
    await this.admin.rejectRequest(request.identity.supabaseUuid, id, input)
    return { ok: true as const }
  }
}
