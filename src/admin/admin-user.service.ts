import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"

import { isDatabaseAdminDenial } from "./admin-database.js"
import type { AdminSetUserAccessInput } from "./admin-user.input.js"
import { AdminUserRepository, type AdminUserAccessRow } from "./admin-user.repository.js"

const USER_STATE_ERRORS: Record<string, { path: string; message: string }> = {
  ADMIN_USER_ACCESS_SELF_DISABLE: { path: "is_enabled", message: "cannot disable your own access" },
  ADMIN_USER_ACCESS_SELF_DELETE: { path: "id", message: "cannot delete your own account" },
  ADMIN_USER_ACCESS_CANNOT_DELETE_ADMIN: {
    path: "id",
    message: "cannot delete an administrator account",
  },
}

@Injectable()
export class AdminUserService {
  constructor(private readonly repository: AdminUserRepository) {}

  private async call<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      if (isDatabaseAdminDenial(error)) {
        throw new ForbiddenException("admin access is not provisioned")
      }
      if (typeof error === "object" && error !== null) {
        const failure = error as { message?: unknown }
        if (failure.message === "ADMIN_USER_ACCESS_NOT_FOUND") throw new NotFoundException()
        if (typeof failure.message === "string") {
          const issue = USER_STATE_ERRORS[failure.message]
          if (issue !== undefined) {
            throw new BadRequestException({
              statusCode: 400,
              message: "invalid request body",
              error: "Bad Request",
              issues: [issue],
            })
          }
        }
      }
      throw error
    }
  }

  list(actor: string): Promise<AdminUserAccessRow[]> {
    return this.call(() => this.repository.list(actor))
  }

  setAccess(
    actor: string,
    userId: string,
    input: AdminSetUserAccessInput
  ): Promise<AdminUserAccessRow> {
    return this.call(() => this.repository.setAccess(actor, userId, input))
  }

  async delete(actor: string, userId: string): Promise<void> {
    await this.call(() => this.repository.delete(actor, userId))
  }
}
