import type { INestApplication } from "@nestjs/common"
import { ConfigModule } from "@nestjs/config"
import { Test } from "@nestjs/testing"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { AdminModule } from "../src/admin/admin.module.js"
import { AdminStatisticsRepository } from "../src/admin/admin-statistics.repository.js"
import { IdentityService } from "../src/auth/identity.service.js"
import { DbModule } from "../src/db/db.module.js"
import { DbService } from "../src/db/db.service.js"

vi.mock("@clerk/backend", () => ({
  verifyToken: vi.fn(async (token: string) => {
    if (["operator", "member", "unmapped"].includes(token)) return { sub: `user_${token}` }
    throw new Error("expired or invalid token")
  }),
}))

const ACTOR = "11111111-1111-4111-8111-111111111111"
const dashboard = {
  total_events: 3,
  draft_events: 1,
  published_events: 2,
  ai_confidence: { high: 1, medium: 1, low: 1 },
  sources: { active: 2, errors: 1 },
  dead_letters: {
    tag_queue: 1,
    source_queue: 2,
    oldest_tag_dead_at: null,
    oldest_source_dead_at: "2026-06-10 18:00:00.123456+00",
  },
  generated_at: "2026-06-10 18:00:00.654321+00",
}
const pipeline = {
  window_days: 30,
  total_reviewed: 4,
  llm_reviewed: 3,
  admin_reviewed: 2,
  auto_rejected: 1,
  memory_hits: 1,
  total_embeddings: 2,
  tag_memory_hits: 1,
  top_rejection_sources: [],
  feature_flags: {},
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

describe("admin statistics HTTP with the real guard chain", () => {
  let app: INestApplication
  const repository = { dashboard: vi.fn(), pipeline: vi.fn() }
  const routes = [
    { key: "dashboard", path: "/v1/admin/dashboard/stats", expected: dashboard },
    { key: "pipeline", path: "/v1/admin/statistics/pipeline", expected: pipeline },
  ] as const

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ CLERK_SECRET_KEY: "sk_test_admin_statistics" })],
        }),
        DbModule,
        AdminModule,
      ],
    })
      .overrideProvider(IdentityService)
      .useValue(identity)
      .overrideProvider(DbService)
      .useValue({})
      .overrideProvider(AdminStatisticsRepository)
      .useValue(repository)
      .compile()
    app = module.createNestApplication()
    await app.init()
  })

  afterAll(async () => app.close())
  beforeEach(() => {
    vi.resetAllMocks()
    repository.dashboard.mockResolvedValue(dashboard)
    repository.pipeline.mockResolvedValue(pipeline)
  })

  for (const route of routes) {
    describe(`GET ${route.path}`, () => {
      it.each([
        [undefined, 401, "Unauthorized", "missing bearer token"],
        ["invalid", 401, "Unauthorized", "invalid token"],
        ["unmapped", 403, "Forbidden", "user is not provisioned"],
        ["member", 404, undefined, "Not Found"],
      ])("rejects %s before repository access", async (token, statusCode, error, message) => {
        const operation = request(app.getHttpServer()).get(route.path)
        if (token !== undefined) operation.set("Authorization", `Bearer ${token}`)
        const response = await operation
        expect(response.status).toBe(statusCode)
        expect(response.body).toEqual({ statusCode, message, ...(error ? { error } : {}) })
        expect(repository.dashboard).not.toHaveBeenCalled()
        expect(repository.pipeline).not.toHaveBeenCalled()
      })

      it("uses only the mapped operator actor", async () => {
        const response = await request(app.getHttpServer())
          .get(route.path)
          .set("Authorization", "Bearer operator")
          .set("X-Actor-Id", "22222222-2222-4222-8222-222222222222")
        expect(response.status).toBe(200)
        expect(response.body).toEqual(route.expected)
        if (route.key === "dashboard") expect(repository.dashboard).toHaveBeenCalledWith(ACTOR)
        else expect(repository.pipeline).toHaveBeenCalledWith(ACTOR, 30)
      })

      it("maps database authorization denial to the stable 403", async () => {
        repository[route.key].mockRejectedValueOnce({ code: "42501", message: "forbidden" })
        const response = await request(app.getHttpServer())
          .get(route.path)
          .set("Authorization", "Bearer operator")
        expect(response.status).toBe(403)
        expect(response.body).toEqual({
          statusCode: 403,
          error: "Forbidden",
          message: "admin access is not provisioned",
        })
      })
    })
  }

  it.each([
    "/v1/admin/dashboard/stats?extra=1",
    "/v1/admin/statistics/pipeline?window_days=0",
    "/v1/admin/statistics/pipeline?window_days=1.5",
    "/v1/admin/statistics/pipeline?window_days=366",
    "/v1/admin/statistics/pipeline?extra=1",
  ])("rejects invalid query %s without repository access", async (path) => {
    const response = await request(app.getHttpServer())
      .get(path)
      .set("Authorization", "Bearer operator")
    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({
      statusCode: 400,
      message: "invalid query parameters",
      error: "Bad Request",
      issues: expect.any(Array),
    })
    expect(repository.dashboard).not.toHaveBeenCalled()
    expect(repository.pipeline).not.toHaveBeenCalled()
  })
})
