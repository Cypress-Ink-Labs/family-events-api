import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common"
import { describe, expect, it, vi } from "vitest"

import { AdminAccessDeniedError } from "./admin-database.js"
import type { AdminInviteRepository } from "./admin-invite.repository.js"
import { AdminInviteService } from "./admin-invite.service.js"

function service(methods: Partial<AdminInviteRepository>) {
  return new AdminInviteService(methods as AdminInviteRepository)
}

describe("AdminInviteService", () => {
  it("rejects past and equal expiries before repository access", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-09-08T12:00:00Z"))
    const createCode = vi.fn()
    const subject = service({ createCode } as Partial<AdminInviteRepository>)
    expect(() =>
      subject.createCode("actor", { maxUses: 1, expiresAt: "2026-09-08T12:00:00Z" })
    ).toThrow(BadRequestException)
    expect(createCode).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it("maps database provisioning denial to a stable 403", async () => {
    const subject = service({ required: vi.fn().mockRejectedValue(new AdminAccessDeniedError()) })
    await expect(subject.required("actor")).rejects.toMatchObject({
      constructor: ForbiddenException,
      message: "admin access is not provisioned",
    })
  })

  it("conceals missing and already-revoked codes as 404", async () => {
    const subject = service({ revokeCode: vi.fn().mockResolvedValue(false) })
    await expect(subject.revokeCode("actor", "id")).rejects.toBeInstanceOf(NotFoundException)
  })

  it("projects list fields and converts PostgreSQL counters", async () => {
    const subject = service({
      listCodes: vi.fn().mockResolvedValue([
        {
          id: "id",
          max_uses: "2",
          used_count: "1",
          expires_at: null,
          revoked_at: null,
          notes: null,
          created_by: null,
          created_at: "timestamp",
          code_hash: "must not leak",
        },
      ]),
    } as Partial<AdminInviteRepository>)
    expect(await subject.listCodes("actor")).toEqual([
      {
        id: "id",
        max_uses: 2,
        used_count: 1,
        expires_at: null,
        revoked_at: null,
        notes: null,
        created_by: null,
        created_at: "timestamp",
      },
    ])
  })

  it("conceals missing or reviewed invite requests", async () => {
    const reject = service({ rejectRequest: vi.fn().mockResolvedValue(false) })
    await expect(reject.rejectRequest("actor", "id", {})).rejects.toBeInstanceOf(NotFoundException)

    const approve = service({
      approveRequest: vi.fn().mockRejectedValue({
        code: "P0002",
        message: "request not found or already reviewed",
      }),
    })
    await expect(approve.approveRequest("actor", "id")).rejects.toBeInstanceOf(NotFoundException)
  })

  it("projects request rows and one-time approval fields", async () => {
    const row = {
      id: "request",
      email: "person@example.com",
      message: null,
      status: "pending" as const,
      invite_code_id: null,
      admin_notes: null,
      created_at: "created",
      reviewed_at: null,
      reviewed_by: null,
      hidden: "must not leak",
    }
    const subject = service({
      listRequests: vi.fn().mockResolvedValue([row]),
      approveRequest: vi.fn().mockResolvedValue({
        request_id: "request",
        code: "ONCE",
        invite_code_id: "code",
        email: row.email,
        created_at: "created",
        hidden: "must not leak",
      }),
    })
    expect(await subject.listRequests("actor", "pending")).toEqual([
      {
        id: row.id,
        email: row.email,
        message: null,
        status: "pending",
        invite_code_id: null,
        admin_notes: null,
        created_at: "created",
        reviewed_at: null,
        reviewed_by: null,
      },
    ])
    expect(await subject.approveRequest("actor", "request")).toEqual({
      request_id: "request",
      code: "ONCE",
      invite_code_id: "code",
      email: row.email,
      created_at: "created",
    })
  })
})
