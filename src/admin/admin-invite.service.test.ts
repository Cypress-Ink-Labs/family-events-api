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
})
