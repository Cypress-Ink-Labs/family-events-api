import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common"
import { describe, expect, it, vi } from "vitest"

import { AdminAccessDeniedError } from "./admin-database.js"
import type { AdminUpdateEventInput } from "./admin-event-editor.input.js"
import type { AdminEventEditorRepository } from "./admin-event-editor.repository.js"
import { AdminEventEditorService } from "./admin-event-editor.service.js"

const INPUT: AdminUpdateEventInput = {
  patch: { description: null },
  tagIds: [],
  lockEditedFields: true,
  decisionReason: null,
}

function setup() {
  const detail = { event: { id: "event" }, tags: [], availableTags: [] }
  const repository = {
    get: vi.fn().mockResolvedValue(detail),
    update: vi.fn().mockResolvedValue(detail),
    unlock: vi.fn().mockResolvedValue(1),
  }
  return {
    detail,
    repository,
    service: new AdminEventEditorService(repository as unknown as AdminEventEditorRepository),
  }
}

describe("AdminEventEditorService", () => {
  it("forwards only trusted actor, event, and parsed input values", async () => {
    const { detail, repository, service } = setup()
    await expect(service.get("actor", "event")).resolves.toBe(detail)
    await expect(service.update("actor", "event", INPUT)).resolves.toBe(detail)
    await expect(service.unlock("actor", "event")).resolves.toBe(1)
    expect(repository.get).toHaveBeenCalledWith("actor", "event")
    expect(repository.update).toHaveBeenCalledWith("actor", "event", INPUT)
    expect(repository.unlock).toHaveBeenCalledWith("actor", "event")
  })

  it("conceals missing events on reads and legacy mutation errors", async () => {
    const { repository, service } = setup()
    repository.get.mockResolvedValueOnce(null)
    await expect(service.get("actor", "event")).rejects.toBeInstanceOf(NotFoundException)
    for (const operation of ["update", "unlock"] as const) {
      repository[operation].mockRejectedValueOnce({
        code: "P0001",
        message: "ADMIN_EVENT_NOT_FOUND",
      })
      await expect(
        operation === "update"
          ? service.update("actor", "event", INPUT)
          : service.unlock("actor", "event")
      ).rejects.toBeInstanceOf(NotFoundException)
    }
  })

  it.each([
    new AdminAccessDeniedError(),
    { code: "42501", message: "forbidden" },
    { code: "P0001", message: "ADMIN_EVENT_ADMIN_REQUIRED" },
  ])("maps verified database admin denial to the stable 403", async (failure) => {
    const { repository, service } = setup()
    repository.update.mockRejectedValueOnce(failure)
    await expect(service.update("actor", "event", INPUT)).rejects.toBeInstanceOf(ForbiddenException)
    await expect(service.update("actor", "event", INPUT)).resolves.toBeDefined()
  })

  it.each([
    ["ADMIN_EVENT_TITLE_REQUIRED", "patch.title"],
    ["ADMIN_EVENT_END_BEFORE_START", "patch.end_datetime"],
    ["ADMIN_EVENT_INVALID_AGE_RANGE", "patch.age_max"],
    ["ADMIN_EVENT_INVALID_PRICE", "patch.price"],
    ["ADMIN_EVENT_INVALID_STATUS", "patch.status"],
  ])("maps %s to a typed parser-shaped 400", async (message, path) => {
    const { repository, service } = setup()
    repository.update.mockRejectedValueOnce({ code: "P0001", message })
    try {
      await service.update("actor", "event", INPUT)
      throw new Error("expected service failure")
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException)
      expect((error as BadRequestException).getResponse()).toMatchObject({
        statusCode: 400,
        message: "invalid request body",
        error: "Bad Request",
        issues: [expect.objectContaining({ path })],
      })
    }
  })

  it("preserves unrelated database and transport failures", async () => {
    const { repository, service } = setup()
    const failure = Object.assign(new Error("connection failed"), { code: "08006" })
    repository.update.mockRejectedValueOnce(failure)
    await expect(service.update("actor", "event", INPUT)).rejects.toBe(failure)
  })
})
