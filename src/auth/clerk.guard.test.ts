import { UnauthorizedException } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import type { ExecutionContext } from "@nestjs/common"
import { describe, expect, it, vi } from "vitest"

import { ClerkAuthGuard } from "./clerk.guard.js"

vi.mock("@clerk/backend", () => ({
  verifyToken: vi.fn(async (token: string) => {
    if (token === "valid-token") return { sub: "user_123" }
    throw new Error("bad token")
  }),
}))

function makeContext(authorization?: string): {
  context: ExecutionContext
  request: { headers: Record<string, string | undefined>; user?: unknown }
} {
  const request: { headers: Record<string, string | undefined>; user?: unknown } = {
    headers: { authorization },
  }
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext
  return { context, request }
}

function makeGuard(secretKey?: string): ClerkAuthGuard {
  const config = new ConfigService({ CLERK_SECRET_KEY: secretKey })
  return new ClerkAuthGuard(config as unknown as ConfigService<never, true>)
}

describe("ClerkAuthGuard", () => {
  it("rejects a request without a bearer token", async () => {
    const guard = makeGuard("sk_test_x")
    const { context } = makeContext()
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException)
  })

  it("fails closed when CLERK_SECRET_KEY is not configured", async () => {
    const guard = makeGuard(undefined)
    const { context } = makeContext("Bearer valid-token")
    await expect(guard.canActivate(context)).rejects.toThrow(/not configured/)
  })

  it("rejects an invalid token", async () => {
    const guard = makeGuard("sk_test_x")
    const { context } = makeContext("Bearer nope")
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException)
  })

  it("attaches the Clerk user id on success", async () => {
    const guard = makeGuard("sk_test_x")
    const { context, request } = makeContext("Bearer valid-token")
    await expect(guard.canActivate(context)).resolves.toBe(true)
    expect(request.user).toEqual({ clerkUserId: "user_123" })
  })
})
