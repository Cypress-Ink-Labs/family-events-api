import { GUARDS_METADATA } from "@nestjs/common/constants.js"
import { describe, expect, it, vi } from "vitest"

import { ClerkAuthGuard } from "../auth/clerk.guard.js"
import { MappedIdentityGuard } from "../auth/mapped-identity.guard.js"
import { OperatorGuard } from "../auth/operator.guard.js"
import { AdminDeadLetterController } from "./admin-dead-letter.controller.js"

describe("AdminDeadLetterController", () => {
  it("keeps authentication, identity mapping, and concealment guards in order", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminDeadLetterController)).toEqual([
      ClerkAuthGuard,
      MappedIdentityGuard,
      OperatorGuard,
    ])
  })

  it("uses only the mapped actor and maps retry output", async () => {
    const service = {
      retry: vi
        .fn()
        .mockResolvedValue({ disposition: "queued", resultingQueueId: "9007199254740993" }),
    }
    const controller = new AdminDeadLetterController(service as never)
    await expect(
      controller.retry("tag", "9007199254740993", {}, {
        identity: { supabaseUuid: "mapped" },
      } as never)
    ).resolves.toEqual({ status: "queued", resulting_queue_id: "9007199254740993" })
    expect(service.retry).toHaveBeenCalledWith("mapped", "tag", "9007199254740993")
  })

  it("validates path and body before service access", async () => {
    const service = { retry: vi.fn(), remove: vi.fn() }
    const controller = new AdminDeadLetterController(service as never)
    await expect(controller.retry("tag", "1", { actor: "spoof" }, {} as never)).rejects.toThrow()
    await expect(controller.remove("bad", "1", {}, {} as never)).rejects.toThrow()
    expect(service.retry).not.toHaveBeenCalled()
    expect(service.remove).not.toHaveBeenCalled()
  })
})
