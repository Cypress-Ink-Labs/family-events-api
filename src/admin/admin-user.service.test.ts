import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common"
import { describe, expect, it, vi } from "vitest"

import { AdminAccessDeniedError } from "./admin-database.js"
import type { AdminUserRepository } from "./admin-user.repository.js"
import { AdminUserService } from "./admin-user.service.js"

function setup() {
  const row = { user_id: "user" }
  const repository = {
    list: vi.fn().mockResolvedValue([row]),
    setAccess: vi.fn().mockResolvedValue(row),
    delete: vi.fn().mockResolvedValue(undefined),
  }
  return {
    repository,
    service: new AdminUserService(repository as unknown as AdminUserRepository),
  }
}

describe("AdminUserService", () => {
  it("forwards trusted actor and target values", async () => {
    const { repository, service } = setup()
    await service.list("actor")
    await service.setAccess("actor", "user", { isEnabled: false, disabledReason: "reason" })
    await service.delete("actor", "user")
    expect(repository.setAccess).toHaveBeenCalledWith("actor", "user", {
      isEnabled: false,
      disabledReason: "reason",
    })
    expect(repository.delete).toHaveBeenCalledWith("actor", "user")
  })

  it.each([
    new AdminAccessDeniedError(),
    { code: "42501", message: "forbidden" },
    { message: "ADMIN_USER_ACCESS_ADMIN_REQUIRED" },
  ])("maps database access denial to 403", async (failure) => {
    const { repository, service } = setup()
    repository.list.mockRejectedValueOnce(failure)
    await expect(service.list("actor")).rejects.toBeInstanceOf(ForbiddenException)
  })

  it("maps missing and protected account operations", async () => {
    const { repository, service } = setup()
    repository.setAccess.mockRejectedValueOnce({ message: "ADMIN_USER_ACCESS_NOT_FOUND" })
    await expect(
      service.setAccess("actor", "user", { isEnabled: true, disabledReason: null })
    ).rejects.toBeInstanceOf(NotFoundException)
    for (const message of [
      "ADMIN_USER_ACCESS_SELF_DISABLE",
      "ADMIN_USER_ACCESS_SELF_DELETE",
      "ADMIN_USER_ACCESS_CANNOT_DELETE_ADMIN",
    ]) {
      repository.delete.mockRejectedValueOnce({ message })
      await expect(service.delete("actor", "user")).rejects.toBeInstanceOf(BadRequestException)
    }
  })
})
