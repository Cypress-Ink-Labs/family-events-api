import { GUARDS_METADATA } from "@nestjs/common/constants.js"
import { describe, expect, it, vi } from "vitest"

import { ClerkAuthGuard } from "../auth/clerk.guard.js"
import { MappedIdentityGuard } from "../auth/mapped-identity.guard.js"
import { OperatorGuard } from "../auth/operator.guard.js"
import { CRON_LABELS } from "./admin-cron.input.js"
import { AdminCronController } from "./admin-cron.controller.js"

describe("AdminCronController", () => {
  it("keeps claims, mapping, and operator concealment guards in order", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminCronController)).toEqual([
      ClerkAuthGuard,
      MappedIdentityGuard,
      OperatorGuard,
    ])
  })

  it("passes only parsed parameters and the mapped actor", async () => {
    const service = {
      schedules: vi.fn(),
      runs: vi.fn(),
      detail: vi.fn(),
    }
    const controller = new AdminCronController(service as never)
    const request = { identity: { supabaseUuid: "mapped-actor" } } as never
    await controller.list({}, request)
    await controller.runs({ label: CRON_LABELS[0], limit: "200" }, request)
    await controller.detail("9223372036854775807", request)
    expect(service.schedules).toHaveBeenCalledWith("mapped-actor")
    expect(service.runs).toHaveBeenCalledWith("mapped-actor", CRON_LABELS[0], 200)
    expect(service.detail).toHaveBeenCalledWith("mapped-actor", "9223372036854775807")
  })
})
