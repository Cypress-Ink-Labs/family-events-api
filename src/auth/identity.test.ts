import { ForbiddenException } from "@nestjs/common"
import type { ExecutionContext } from "@nestjs/common"
import { describe, expect, it, vi } from "vitest"

import type { DbService } from "../db/db.service.js"
import { IdentityService, type MappedIdentity } from "./identity.service.js"
import { MappedIdentityGuard } from "./mapped-identity.guard.js"
import { OperatorGuard } from "./operator.guard.js"

const MAPPING_ROW = {
  supabase_uuid: "0b6a3f5e-1111-4222-8333-444455556666",
  email: "jacob@example.com",
  role: "operator" as const,
}

function makeIdentityService(rows: (typeof MAPPING_ROW)[]) {
  const query = vi.fn(async () => rows)
  return new IdentityService({ query } as unknown as DbService)
}

function makeContext(request: object): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext
}

describe("IdentityService", () => {
  it("resolves a provisioned Clerk user to its mapped identity", async () => {
    const service = makeIdentityService([MAPPING_ROW])
    expect(await service.resolve("user_abc")).toEqual({
      clerkUserId: "user_abc",
      supabaseUuid: MAPPING_ROW.supabase_uuid,
      email: MAPPING_ROW.email,
      role: "operator",
    })
  })

  it("returns null for an unprovisioned user", async () => {
    const service = makeIdentityService([])
    expect(await service.resolve("user_ghost")).toBeNull()
  })
})

describe("MappedIdentityGuard", () => {
  it("attaches the mapped identity to the request", async () => {
    const guard = new MappedIdentityGuard(makeIdentityService([MAPPING_ROW]))
    const request: { user: { clerkUserId: string }; identity?: MappedIdentity } = {
      user: { clerkUserId: "user_abc" },
    }
    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true)
    expect(request.identity?.supabaseUuid).toBe(MAPPING_ROW.supabase_uuid)
  })

  it("forbids verified but unprovisioned users", async () => {
    const guard = new MappedIdentityGuard(makeIdentityService([]))
    const request = { user: { clerkUserId: "user_ghost" } }
    await expect(guard.canActivate(makeContext(request))).rejects.toThrow(ForbiddenException)
  })
})

describe("OperatorGuard", () => {
  const identity = (role: "operator" | "member"): MappedIdentity => ({
    clerkUserId: "user_abc",
    supabaseUuid: MAPPING_ROW.supabase_uuid,
    email: MAPPING_ROW.email,
    role,
  })

  it("allows operators", () => {
    const guard = new OperatorGuard()
    expect(guard.canActivate(makeContext({ identity: identity("operator") }))).toBe(true)
  })

  it("forbids members", () => {
    const guard = new OperatorGuard()
    expect(() => guard.canActivate(makeContext({ identity: identity("member") }))).toThrow(
      ForbiddenException
    )
  })
})
