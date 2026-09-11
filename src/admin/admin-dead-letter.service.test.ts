import { ForbiddenException, NotFoundException } from "@nestjs/common"
import { describe, expect, it, vi } from "vitest"

import { AdminDeadLetterService } from "./admin-dead-letter.service.js"

describe("AdminDeadLetterService", () => {
  it("limits the page and builds a cursor from the last returned raw timestamp", async () => {
    const rows = [1, 2, 3].map((id) => ({
      id: String(id),
      finished_at: id === 2 ? null : `2026-06-0${id} 00:00:00.123456+00`,
    }))
    const service = new AdminDeadLetterService({ list: vi.fn().mockResolvedValue(rows) } as never)
    const page = await service.list("actor", { queue: "tag", limit: 2, cursor: null })
    expect(page.items).toEqual(rows.slice(0, 2).map((row) => ({ ...row, queue: "tag" })))
    expect(page.nextCursor).not.toBeNull()
  })

  it.each(["retry", "remove"] as const)("maps a missing %s to 404", async (method) => {
    const repository = {
      retry: vi.fn().mockResolvedValue(null),
      remove: vi.fn().mockResolvedValue(false),
    }
    const service = new AdminDeadLetterService(repository as never)
    await expect(
      method === "retry"
        ? service.retry("actor", "source", "1")
        : service.remove("actor", "source", "1")
    ).rejects.toBeInstanceOf(NotFoundException)
  })

  it("translates database authorization errors and preserves unrelated failures", async () => {
    const repository = { retry: vi.fn().mockRejectedValue({ code: "42501" }) }
    const service = new AdminDeadLetterService(repository as never)
    await expect(service.retry("actor", "tag", "1")).rejects.toBeInstanceOf(ForbiddenException)
    repository.retry.mockRejectedValueOnce(new Error("network"))
    await expect(service.retry("actor", "tag", "1")).rejects.toThrow("network")
  })
})
