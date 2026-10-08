import { AccountDeletionDto, AdminManagedUserDto } from "../user-access/account-deletion.dto.js"
import {
  HttpException,
  ServiceUnavailableException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common"
import {
  ApiServiceUnavailableResponse,
  ApiConflictResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger"

import { ClerkAuthGuard } from "../auth/clerk.guard.js"
import { MappedIdentityGuard, type IdentifiedRequest } from "../auth/mapped-identity.guard.js"
import { OperatorGuard } from "../auth/operator.guard.js"
import { AdminErrorDto, AdminValidationErrorDto } from "./admin-review.dto.js"
import {
  ADMIN_SET_USER_ACCESS_BODY_SCHEMA,
  AdminUserAccessDto,
  AdminUserMutationResultDto,
} from "./admin-user.dto.js"
import {
  parseAdminDeleteUserBody,
  parseAdminSetUserAccessBody,
  parseAdminUserId,
  parseAdminUsersQuery,
} from "./admin-user.input.js"
import { AccountDeletionService } from "../user-access/account-deletion.service.js"
import { AdminUserService } from "./admin-user.service.js"

type AdminRequest = Pick<IdentifiedRequest, "identity">

@ApiServiceUnavailableResponse({ type: AdminErrorDto })
@ApiTags("admin")
@ApiBearerAuth("clerk")
@ApiUnauthorizedResponse({
  type: AdminErrorDto,
  description: "A valid Clerk bearer token is required",
})
@ApiForbiddenResponse({
  type: AdminErrorDto,
  description:
    "The Clerk user is not provisioned, or database admin access is not provisioned. Database denial returns the stable message: admin access is not provisioned.",
})
@ApiNotFoundResponse({
  type: AdminErrorDto,
  description: "The mapped user is not an operator, or the user does not exist",
})
@ApiBadRequestResponse({
  type: AdminValidationErrorDto,
  description: "Invalid path, query parameters, request body, or protected account operation",
})
@UseGuards(ClerkAuthGuard, MappedIdentityGuard, OperatorGuard)
@Controller("v1/admin/users")
export class AdminUserController {
  constructor(
    private readonly admin: AdminUserService,
    private readonly deletion: AccountDeletionService
  ) {}
  private async available<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action()
    } catch (error) {
      if (error instanceof HttpException) throw error
      throw new ServiceUnavailableException(
        "Account access is unavailable. Check deletion status before retrying."
      )
    }
  }
  @Get("deletions")
  @ApiOperation({
    operationId: "adminListAccountDeletions",
    summary: "List the latest 100 coordinated account deletion outcomes",
  })
  @ApiOkResponse({ type: [AccountDeletionDto] })
  deletions(@Req() request: AdminRequest) {
    return this.available(() => this.deletion.list(request.identity.supabaseUuid))
  }

  @Get()
  @ApiOperation({ operationId: "adminListUsers", summary: "List user access records" })
  @ApiOkResponse({ type: [AdminManagedUserDto] })
  list(
    @Query() query: Record<string, unknown>,
    @Req() request: AdminRequest
  ): Promise<AdminManagedUserDto[]> {
    parseAdminUsersQuery(query)
    return this.available(async () =>
      this.deletion.managed(
        request.identity.supabaseUuid,
        await this.admin.list(request.identity.supabaseUuid)
      )
    )
  }

  @Put(":id/access")
  @ApiOperation({ operationId: "adminSetUserAccess", summary: "Enable or disable user access" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ schema: ADMIN_SET_USER_ACCESS_BODY_SCHEMA })
  @ApiOkResponse({ type: AdminUserAccessDto })
  setAccess(
    @Param("id") rawId: string,
    @Body() body: unknown,
    @Req() request: AdminRequest
  ): Promise<AdminUserAccessDto> {
    const id = parseAdminUserId(rawId)
    const input = parseAdminSetUserAccessBody(body)
    return this.available(() => this.admin.setAccess(request.identity.supabaseUuid, id, input))
  }

  @Delete(":id")
  @ApiConflictResponse({
    type: AdminErrorDto,
    description:
      "Deletion is already processing or protected attribution requires retained UUID storage.",
  })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: "adminDeleteUser",
    summary: "Revoke and delete a permitted account across Clerk and retained UUID storage",
  })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ type: AdminUserMutationResultDto })
  async delete(
    @Param("id") rawId: string,
    @Body() body: unknown,
    @Req() request: AdminRequest
  ): Promise<AdminUserMutationResultDto> {
    const id = parseAdminUserId(rawId)
    parseAdminDeleteUserBody(body)
    await this.available(() => this.deletion.delete(request.identity.supabaseUuid, id))
    return { ok: true }
  }
}
