import { verifyToken } from "@clerk/backend"
import { UnauthorizedException, type ExecutionContext } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { IdentityService, type MappedIdentity } from "./identity.service.js"
import { OptionalClerkAuthGuard } from "./optional-clerk.guard.js"

vi.mock("@clerk/backend", () => ({
  verifyToken: vi.fn(async (token: string) => {
    if (token === "valid-token") return { sub: "user_123" }
    throw new Error("bad token")
  }),
}))

const MAPPED_IDENTITY: MappedIdentity = {
  clerkUserId: "user_123",
  supabaseUuid: "11111111-1111-4111-8111-111111111111",
  email: "reader@example.com",
  role: "member",
}

function makeContext(authorization?: string): {
  context: ExecutionContext
  request: { headers: Record<string, string | undefined>; identity?: MappedIdentity }
} {
  const request: {
    headers: Record<string, string | undefined>
    identity?: MappedIdentity
  } = { headers: { authorization } }
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext
  return { context, request }
}

function makeGuard(
  mapped: MappedIdentity | null,
  secretKey: string | null = "sk_test_x"
): {
  guard: OptionalClerkAuthGuard
  resolve: ReturnType<typeof vi.fn>
} {
  const config = {
    get: vi.fn(() => secretKey ?? undefined),
  } as unknown as ConfigService<never, true>
  const resolve = vi.fn(async () => mapped)
  const identity = { resolve } as unknown as IdentityService
  return { guard: new OptionalClerkAuthGuard(config, identity), resolve }
}

describe("OptionalClerkAuthGuard", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("allows an anonymous request without verifying or resolving identity", async () => {
    const { guard, resolve } = makeGuard(MAPPED_IDENTITY)
    const { context, request } = makeContext()

    await expect(guard.canActivate(context)).resolves.toBe(true)
    expect(vi.mocked(verifyToken)).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
    expect(request.identity).toBeUndefined()
  })

  it("attaches the mapped identity for a valid bearer token", async () => {
    const { guard, resolve } = makeGuard(MAPPED_IDENTITY)
    const { context, request } = makeContext("Bearer valid-token")

    await expect(guard.canActivate(context)).resolves.toBe(true)
    expect(resolve).toHaveBeenCalledWith("user_123")
    expect(request.identity).toEqual(MAPPED_IDENTITY)
  })

  it("treats a valid but unprovisioned user as anonymous", async () => {
    const { guard } = makeGuard(null)
    const { context, request } = makeContext("Bearer valid-token")

    await expect(guard.canActivate(context)).resolves.toBe(true)
    expect(request.identity).toBeUndefined()
  })

  it.each(["Basic abc", "Bearer invalid-token"])(
    "rejects an invalid authorization value",
    async (authorization) => {
      const { guard } = makeGuard(MAPPED_IDENTITY)
      const { context } = makeContext(authorization)

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException)
    }
  )

  it("fails closed for a bearer token when Clerk is not configured", async () => {
    const { guard } = makeGuard(MAPPED_IDENTITY, null)
    const { context } = makeContext("Bearer valid-token")

    await expect(guard.canActivate(context)).rejects.toThrow(/not configured/)
  })
})
