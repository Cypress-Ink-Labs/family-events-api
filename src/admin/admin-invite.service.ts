import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"

import { isDatabaseAdminDenial } from "./admin-database.js"
import type {
  AdminCreateInviteCodeInput,
  AdminInviteRequestStatus,
  AdminRejectInviteRequestInput,
} from "./admin-invite.input.js"
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

  listRequests(actor: string, status: AdminInviteRequestStatus) {
    return this.call(async () =>
      (await this.repository.listRequests(actor, status)).map((row) => ({
        id: row.id,
        email: row.email,
        message: row.message,
        status: row.status,
        invite_code_id: row.invite_code_id,
        admin_notes: row.admin_notes,
        created_at: row.created_at,
        reviewed_at: row.reviewed_at,
        reviewed_by: row.reviewed_by,
      }))
    )
  }

  async approveRequest(actor: string, id: string) {
    try {
      const row = await this.call(() => this.repository.approveRequest(actor, id))
      return {
        request_id: row.request_id,
        code: row.code,
        invite_code_id: row.invite_code_id,
        email: row.email,
        created_at: row.created_at,
      }
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "P0002" &&
        "message" in error &&
        error.message === "request not found or already reviewed"
      )
        throw new NotFoundException()
      throw error
    }
  }

  async rejectRequest(actor: string, id: string, input: AdminRejectInviteRequestInput) {
    if (!(await this.call(() => this.repository.rejectRequest(actor, id, input))))
      throw new NotFoundException()
  }
}
