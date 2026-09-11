import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"

import { isDatabaseAdminDenial } from "./admin-database.js"
import type { AdminCreateInviteCodeInput } from "./admin-invite.input.js"
import { AdminInviteRepository } from "./admin-invite.repository.js"

@Injectable()
export class AdminInviteService {
  constructor(private readonly repository: AdminInviteRepository) {}

  private async call<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      if (isDatabaseAdminDenial(error)) {
        throw new ForbiddenException("admin access is not provisioned")
      }
      throw error
    }
  }

  required(actor: string): Promise<boolean> {
    return this.call(() => this.repository.required(actor))
  }
  listCodes(actor: string) {
    return this.call(async () =>
      (await this.repository.listCodes(actor)).map((row) => {
        const maxUses = Number(row.max_uses)
        const usedCount = Number(row.used_count)
        if (!Number.isSafeInteger(maxUses) || !Number.isSafeInteger(usedCount)) {
          throw new Error("invite code counter is outside the safe integer range")
        }
        return {
          id: row.id,
          max_uses: maxUses,
          used_count: usedCount,
          expires_at: row.expires_at,
          revoked_at: row.revoked_at,
          notes: row.notes,
          created_by: row.created_by,
          created_at: row.created_at,
        }
      })
    )
  }
  createCode(actor: string, input: AdminCreateInviteCodeInput) {
    if (input.expiresAt != null && new Date(input.expiresAt).getTime() <= Date.now()) {
      throw new BadRequestException({
        statusCode: 400,
        message: "invalid request body",
        error: "Bad Request",
        issues: [{ path: "expires_at", message: "must be in the future" }],
      })
    }
    return this.call(async () => {
      const row = await this.repository.createCode(actor, input)
      return {
        id: row.id,
        code: row.code,
        max_uses: Number(row.max_uses),
        expires_at: row.expires_at,
        notes: row.notes,
        created_at: row.created_at,
      }
    })
  }
  async revokeCode(actor: string, id: string): Promise<void> {
    if (!(await this.call(() => this.repository.revokeCode(actor, id))))
      throw new NotFoundException()
  }
}
