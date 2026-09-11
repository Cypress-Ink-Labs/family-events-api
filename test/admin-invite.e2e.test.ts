import type { INestApplication } from "@nestjs/common"
import { ConfigModule } from "@nestjs/config"
import { Test } from "@nestjs/testing"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { AdminInviteRepository } from "../src/admin/admin-invite.repository.js"
import { AdminModule } from "../src/admin/admin.module.js"
import { IdentityService } from "../src/auth/identity.service.js"
import { DbModule } from "../src/db/db.module.js"
import { DbService } from "../src/db/db.service.js"

vi.mock("@clerk/backend", () => ({
  verifyToken: vi.fn(async (token: string) => {
    if (["operator", "member", "unmapped"].includes(token)) return { sub: `user_${token}` }
    throw new Error("invalid token")
  }),
}))

const ACTOR = "11111111-1111-4111-8111-111111111111"
const CODE = "22222222-2222-4222-8222-222222222222"
const INVITE_REQUEST = "33333333-3333-4333-8333-333333333333"
const identity = {
  resolve: vi.fn(async (clerkUserId: string) =>
    clerkUserId === "user_unmapped"
      ? null
      : {
          clerkUserId,
          supabaseUuid: ACTOR,
          email: "operator@example.com",
          role: clerkUserId === "user_operator" ? "operator" : "member",
        }
  ),
}
const routes = [
  { key: "required", method: "get", path: "/v1/admin/invites/required", body: undefined },
  { key: "listCodes", method: "get", path: "/v1/admin/invite-codes", body: undefined },
  {
    key: "createCode",
    method: "post",
    path: "/v1/admin/invite-codes",
    body: { max_uses: 1, notes: null },
  },
  {
    key: "revokeCode",
    method: "delete",
    path: `/v1/admin/invite-codes/${CODE}`,
    body: undefined,
  },
  {
    key: "listRequests",
    method: "get",
    path: "/v1/admin/invite-requests",
    body: undefined,
  },
  {
    key: "approveRequest",
    method: "post",
    path: `/v1/admin/invite-requests/${INVITE_REQUEST}/approve`,
    body: undefined,
  },
  {
    key: "rejectRequest",
    method: "post",
    path: `/v1/admin/invite-requests/${INVITE_REQUEST}/reject`,
    body: { notes: "Not eligible" },
  },
] as const

describe("admin invite HTTP with real guards", () => {
  let app: INestApplication
  const repository = {
    required: vi.fn(),
    listCodes: vi.fn(),
    createCode: vi.fn(),
    revokeCode: vi.fn(),
    listRequests: vi.fn(),
    approveRequest: vi.fn(),
    rejectRequest: vi.fn(),
  }
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ CLERK_SECRET_KEY: "sk_test_admin_invite" })],
        }),
        DbModule,
        AdminModule,
      ],
    })
      .overrideProvider(IdentityService)
      .useValue(identity)
      .overrideProvider(DbService)
      .useValue({})
      .overrideProvider(AdminInviteRepository)
      .useValue(repository)
      .compile()
    app = module.createNestApplication()
    await app.init()
  })
  afterAll(async () => app.close())
  beforeEach(() => {
    vi.resetAllMocks()
    repository.required.mockResolvedValue(false)
    repository.listCodes.mockResolvedValue([])
    repository.createCode.mockResolvedValue({
      id: CODE,
      code: "ONCEONLYCODE",
      max_uses: 1,
      expires_at: null,
      notes: null,
      created_at: "2026-09-08 10:00:00.123456+00",
    })
    repository.revokeCode.mockResolvedValue(true)
    repository.listRequests.mockResolvedValue([])
    repository.approveRequest.mockResolvedValue({
      request_id: INVITE_REQUEST,
      code: "ONCEONLYCODE",
      invite_code_id: CODE,
      email: "requester@example.com",
      created_at: "2026-09-08 10:00:00.123456+00",
    })
    repository.rejectRequest.mockResolvedValue(true)
  })

  for (const route of routes) {
    it.each([
      [undefined, 401],
      ["invalid", 401],
      ["unmapped", 403],
      ["member", 404],
    ])(`${route.method} ${route.path} rejects %s`, async (token, status) => {
      const operation = request(app.getHttpServer())[route.method](route.path)
      if (token) operation.set("Authorization", `Bearer ${token}`)
      if (route.body) operation.send(route.body)
      await operation.expect(status)
      for (const method of Object.values(repository)) expect(method).not.toHaveBeenCalled()
    })

    it(`${route.method} ${route.path} uses the mapped actor`, async () => {
      const http = request(app.getHttpServer())
      const operation = http[route.method](route.path)
        .set("Authorization", "Bearer operator")
        .set("X-Actor-Id", CODE)
      if (route.body) operation.send(route.body)
      await operation.expect(200)
      expect(repository[route.key].mock.calls[0]![0]).toBe(ACTOR)
    })
  }

  it.each([
    ["get", "/v1/admin/invites/required?actor_id=x", undefined],
    ["get", "/v1/admin/invite-codes?code_hash=x", undefined],
    ["post", "/v1/admin/invite-codes", { max_uses: 0 }],
    ["post", "/v1/admin/invite-codes", { max_uses: 1, code: "injected" }],
    ["delete", "/v1/admin/invite-codes/bad", undefined],
    ["delete", `/v1/admin/invite-codes/${CODE}`, { actor_id: ACTOR }],
    ["get", "/v1/admin/invite-requests?status=unknown", undefined],
    ["get", "/v1/admin/invite-requests?status=pending&extra=x", undefined],
    ["post", "/v1/admin/invite-requests/bad/approve", undefined],
    ["post", `/v1/admin/invite-requests/${INVITE_REQUEST}/approve`, { notes: "no" }],
    ["post", `/v1/admin/invite-requests/${INVITE_REQUEST}/reject`, { notes: "x".repeat(1001) }],
    ["post", `/v1/admin/invite-requests/${INVITE_REQUEST}/reject`, { extra: true }],
  ] as const)("rejects invalid %s %s before repository access", async (method, path, body) => {
    const http = request(app.getHttpServer())
    const operation = http[method](path).set("Authorization", "Bearer operator")
    if (body) operation.send(body)
    await operation.expect(400)
    for (const repositoryMethod of Object.values(repository)) {
      expect(repositoryMethod).not.toHaveBeenCalled()
    }
  })
})
