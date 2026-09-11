import type { INestApplication } from "@nestjs/common"
import { ConfigModule } from "@nestjs/config"
import { Test } from "@nestjs/testing"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { AdminCronRepository } from "../src/admin/admin-cron.repository.js"
import { AdminModule } from "../src/admin/admin.module.js"
import { CRON_LABELS } from "../src/admin/admin-cron.input.js"
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
const identity = {
  resolve: vi.fn(async (id: string) =>
    id === "user_unmapped"
      ? null
      : {
          clerkUserId: id,
          supabaseUuid: ACTOR,
          email: "person@example.com",
          role: id === "user_operator" ? "operator" : "member",
        }
  ),
}

describe("admin cron HTTP with the real guard chain", () => {
  let app: INestApplication
  const repository = {
    gatesAndLatest: vi.fn(),
    runs: vi.fn(),
    detail: vi.fn(),
  }
  const routes = ["/v1/admin/crons", "/v1/admin/crons/runs", "/v1/admin/crons/runs/1"]

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ CLERK_SECRET_KEY: "sk_test_cron" })],
        }),
        DbModule,
        AdminModule,
      ],
    })
      .overrideProvider(IdentityService)
      .useValue(identity)
      .overrideProvider(DbService)
      .useValue({})
      .overrideProvider(AdminCronRepository)
      .useValue(repository)
      .compile()
    app = module.createNestApplication()
    await app.init()
  })
  afterAll(async () => app.close())
  beforeEach(() => {
    vi.resetAllMocks()
    repository.gatesAndLatest.mockResolvedValue([])
    repository.runs.mockResolvedValue([])
    repository.detail.mockResolvedValue({
      id: "1",
      run_key: "10000000-0000-4000-8000-000000000001",
      label: CRON_LABELS[0],
      status: "ok",
      ran_at: "2026-06-01 00:00:00.123456+00",
      duration_s: null,
      http_status: null,
      body: null,
      logs: [],
    })
  })

  for (const path of routes) {
    it.each([
      [undefined, 401],
      ["invalid", 401],
      ["unmapped", 403],
      ["member", 404],
    ])(`protects GET ${path} for %s before repository access`, async (token, status) => {
      const operation = request(app.getHttpServer()).get(path)
      if (token) operation.set("Authorization", `Bearer ${token}`)
      expect((await operation).status).toBe(status)
      expect(repository.gatesAndLatest).not.toHaveBeenCalled()
      expect(repository.runs).not.toHaveBeenCalled()
      expect(repository.detail).not.toHaveBeenCalled()
    })
  }

  it("uses the mapped actor on all three routes", async () => {
    const auth = { Authorization: "Bearer operator", "X-Actor-Id": "attacker" }
    await request(app.getHttpServer()).get(routes[0]!).set(auth).expect(200)
    await request(app.getHttpServer()).get(routes[1]!).set(auth).expect(200)
    await request(app.getHttpServer()).get(routes[2]!).set(auth).expect(200)
    expect(repository.gatesAndLatest).toHaveBeenCalledWith(ACTOR, CRON_LABELS)
    expect(repository.runs).toHaveBeenCalledWith(ACTOR, CRON_LABELS, undefined, 50)
    expect(repository.detail).toHaveBeenCalledWith(ACTOR, "1")
  })

  it.each([
    "/v1/admin/crons?extra=1",
    "/v1/admin/crons/runs?extra=1",
    "/v1/admin/crons/runs?label=not-owned",
    "/v1/admin/crons/runs?limit=0",
    "/v1/admin/crons/runs?limit=1.5",
    "/v1/admin/crons/runs?limit=201",
    "/v1/admin/crons/runs/0",
    "/v1/admin/crons/runs/01",
    "/v1/admin/crons/runs/9223372036854775808",
  ])("rejects invalid input without repository access: %s", async (path) => {
    expect(
      (await request(app.getHttpServer()).get(path).set("Authorization", "Bearer operator")).status
    ).toBe(400)
    expect(repository.gatesAndLatest).not.toHaveBeenCalled()
    expect(repository.runs).not.toHaveBeenCalled()
    expect(repository.detail).not.toHaveBeenCalled()
  })

  it.each(["post", "put", "patch", "delete"] as const)(
    "has no %s cron mutation route",
    async (verb) => {
      expect(
        (
          await request(app.getHttpServer())
            [verb]("/v1/admin/crons/runs")
            .set("Authorization", "Bearer operator")
        ).status
      ).toBe(404)
    }
  )
})
