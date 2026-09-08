import "reflect-metadata"

import { BadRequestException } from "@nestjs/common"
import { GUARDS_METADATA } from "@nestjs/common/constants.js"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { ClerkAuthGuard } from "../auth/clerk.guard.js"
import { MappedIdentityGuard } from "../auth/mapped-identity.guard.js"
import { OperatorGuard } from "../auth/operator.guard.js"
import { AdminEventEditorController } from "./admin-event-editor.controller.js"
import type { AdminEventEditorService } from "./admin-event-editor.service.js"

const ACTOR = "11111111-1111-4111-8111-111111111111"
const EVENT = "22222222-2222-4222-8222-222222222222"
const TAG = "33333333-3333-4333-8333-333333333333"
const request = {
  identity: {
    supabaseUuid: ACTOR,
    clerkUserId: "user_operator",
    role: "operator" as const,
    email: "operator@example.test",
  },
}
const detail = {
  event: { id: EVENT },
  tags: [{ id: TAG }],
  availableTags: [{ id: TAG, name: "Storytime" }],
}

describe("AdminEventEditorController", () => {
  const service = {
    get: vi.fn(),
    update: vi.fn(),
    unlock: vi.fn(),
  }
  const controller = new AdminEventEditorController(service as unknown as AdminEventEditorService)

  beforeEach(() => {
    vi.resetAllMocks()
    service.get.mockResolvedValue(detail)
    service.update.mockResolvedValue(detail)
    service.unlock.mockResolvedValue(1)
  })

  it("uses the exact authentication, identity, operator guard order", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminEventEditorController)).toEqual([
      ClerkAuthGuard,
      MappedIdentityGuard,
      OperatorGuard,
    ])
  })

  it("projects editor details to snake_case and takes actor only from mapped identity", async () => {
    await expect(controller.get(EVENT, request)).resolves.toEqual({
      event: { id: EVENT },
      tags: [{ id: TAG }],
      available_tags: [{ id: TAG, name: "Storytime" }],
    })
    expect(service.get).toHaveBeenCalledWith(ACTOR, EVENT)
  })

  it("passes parsed update controls and explicit tags with the trusted actor", async () => {
    await controller.update(
      EVENT,
      {
        patch: { description: null, is_featured: true },
        tag_ids: [TAG],
        lock_edited_fields: false,
        decision_reason: "  fixed  ",
      },
      request
    )
    expect(service.update).toHaveBeenCalledWith(ACTOR, EVENT, {
      patch: { description: null, isFeatured: true },
      tagIds: [TAG],
      lockEditedFields: false,
      decisionReason: "fixed",
    })
  })

  it("returns the common mutation result after unlocking", async () => {
    await expect(controller.unlock(EVENT, undefined, request)).resolves.toEqual({
      ok: true,
      affected: 1,
    })
    expect(service.unlock).toHaveBeenCalledWith(ACTOR, EVENT)
  })

  it.each([
    ["get", "bad-id", undefined],
    ["update", EVENT, { patch: {}, tag_ids: [], actor_id: ACTOR }],
    ["update", EVENT, { patch: { admin_locked_fields: [] }, tag_ids: [] }],
    ["unlock", "bad-id", undefined],
  ] as const)("rejects invalid %s input before service access", async (operation, id, body) => {
    const result =
      operation === "get"
        ? controller.get(id, request)
        : operation === "update"
          ? controller.update(id, body, request)
          : controller.unlock(id, body, request)
    await expect(result).rejects.toBeInstanceOf(BadRequestException)
    for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled()
  })
})
