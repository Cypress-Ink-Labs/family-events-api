import "reflect-metadata"

import { BadRequestException } from "@nestjs/common"
import { GUARDS_METADATA } from "@nestjs/common/constants.js"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { ClerkAuthGuard } from "../auth/clerk.guard.js"
import { MappedIdentityGuard } from "../auth/mapped-identity.guard.js"
import { OperatorGuard } from "../auth/operator.guard.js"
import { AdminInviteController } from "./admin-invite.controller.js"
import type { AdminInviteService } from "./admin-invite.service.js"

const ACTOR = "11111111-1111-4111-8111-111111111111"
const CODE = "22222222-2222-4222-8222-222222222222"
const request = { identity: { supabaseUuid: ACTOR } }

describe("AdminInviteController", () => {
  const service = {
    required: vi.fn(),
    listCodes: vi.fn(),
    createCode: vi.fn(),
    revokeCode: vi.fn(),
  }
  const controller = new AdminInviteController(service as unknown as AdminInviteService)

  beforeEach(() => {
    vi.resetAllMocks()
    service.required.mockResolvedValue(true)
    service.listCodes.mockResolvedValue([{ id: CODE }])
    service.createCode.mockResolvedValue({ id: CODE, code: "once" })
    service.revokeCode.mockResolvedValue(undefined)
  })

  it("uses the exact authentication, identity, operator guard order", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminInviteController)).toEqual([
      ClerkAuthGuard,
      MappedIdentityGuard,
      OperatorGuard,
    ])
  })

  it("passes only the mapped actor and returns fixed projections", async () => {
    await expect(controller.required({}, request as never)).resolves.toEqual({ required: true })
    await expect(controller.list({}, request as never)).resolves.toEqual([{ id: CODE }])
    await expect(
      controller.create({ max_uses: 1, notes: " note " }, request as never)
    ).resolves.toEqual({ id: CODE, code: "once" })
    await expect(controller.revoke(CODE, undefined, request as never)).resolves.toEqual({
      ok: true,
    })
    expect(service.required).toHaveBeenCalledWith(ACTOR)
    expect(service.listCodes).toHaveBeenCalledWith(ACTOR)
    expect(service.createCode).toHaveBeenCalledWith(ACTOR, {
      maxUses: 1,
      notes: "note",
    })
    expect(service.revokeCode).toHaveBeenCalledWith(ACTOR, CODE)
  })

  it.each([
    ["required", { extra: true }],
    ["list", { extra: true }],
    ["create", { max_uses: 0 }],
    ["create", { max_uses: 1, code: "injected" }],
    ["revoke-id", undefined],
    ["revoke-body", { extra: true }],
  ] as const)("rejects invalid %s input before service access", async (operation, input) => {
    const result = (async (): Promise<unknown> =>
      operation === "required"
        ? controller.required(input!, request as never)
        : operation === "list"
          ? controller.list(input!, request as never)
          : operation === "create"
            ? controller.create(input, request as never)
            : controller.revoke(
                operation === "revoke-id" ? "bad-id" : CODE,
                input,
                request as never
              ))()
    await expect(result).rejects.toBeInstanceOf(BadRequestException)
    for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled()
  })
})
