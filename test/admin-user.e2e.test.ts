import type { INestApplication } from "@nestjs/common"
import { ConfigModule } from "@nestjs/config"
import { Test } from "@nestjs/testing"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { AdminModule } from "../src/admin/admin.module.js"
import { AdminUserRepository } from "../src/admin/admin-user.repository.js"
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
const USER = "22222222-2222-4222-8222-222222222222"
const row = {
  user_id: USER,
  is_enabled: true,
  access_expires_at: null,
  enabled_at: null,
  disabled_at: null,
  disabled_reason: null,
  display_name: "Parent",
  email: "parent@example.com",
  role: "user",
  profile_created_at: "2026-09-08 10:00:00.123456+00",
  created_at: "2026-09-08 10:00:00.123456+00",
  updated_at: "2026-09-08 10:00:00.123456+00",
}
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
  { key: "list", method: "get", path: "/v1/admin/users", body: undefined },
  {
    key: "setAccess",
    method: "put",
    path: `/v1/admin/users/${USER}/access`,
    body: { is_enabled: false, disabled_reason: "reason" },
  },
  { key: "delete", method: "delete", path: `/v1/admin/users/${USER}`, body: undefined },
] as const

describe("admin user HTTP with real guards", () => {
  let app: INestApplication
  const repository = {
    list: vi.fn(),
    setAccess: vi.fn(),
    delete: vi.fn(),
  }

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ CLERK_SECRET_KEY: "sk_test_admin_user" })],
        }),
        DbModule,
        AdminModule,
      ],
    })
      .overrideProvider(IdentityService)
      .useValue(identity)
      .overrideProvider(DbService)
      .useValue({})
      .overrideProvider(AdminUserRepository)
      .useValue(repository)
      .compile()
    app = module.createNestApplication()
    await app.init()
  })
  afterAll(async () => app.close())
  beforeEach(() => {
    vi.resetAllMocks()
    repository.list.mockResolvedValue([row])
    repository.setAccess.mockResolvedValue(row)
    repository.delete.mockResolvedValue(undefined)
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

    it(`${route.method} ${route.path} uses mapped actor`, async () => {
      const http = request(app.getHttpServer())
      const operation = http[route.method](route.path)
        .set("Authorization", "Bearer operator")
        .set("X-Actor-Id", USER)
      if (route.body) operation.send(route.body)
      const response = await operation.expect(200)
      expect(repository[route.key].mock.calls[0]![0]).toBe(ACTOR)
      if (route.key === "delete") expect(response.body).toEqual({ ok: true })
    })
  }

  it.each([
    ["get", "/v1/admin/users?actor_id=spoofed", undefined],
    ["put", "/v1/admin/users/bad/access", { is_enabled: true }],
    ["put", `/v1/admin/users/${USER}/access`, { is_enabled: true, actor_id: ACTOR }],
    ["delete", `/v1/admin/users/${USER}`, { actor_id: ACTOR }],
  ] as const)("rejects invalid %s %s before repository access", async (method, path, body) => {
    const http = request(app.getHttpServer())
    const response = await http[method](path).set("Authorization", "Bearer operator").send(body)
    expect(response.status).toBe(400)
    for (const repositoryMethod of Object.values(repository)) {
      expect(repositoryMethod).not.toHaveBeenCalled()
    }
  })
})
