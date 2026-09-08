import type { INestApplication } from "@nestjs/common"
import { ConfigModule } from "@nestjs/config"
import { Test } from "@nestjs/testing"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { AdminModule } from "../src/admin/admin.module.js"
import { AdminSourceRepository } from "../src/admin/admin-source.repository.js"
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
const SOURCE = "22222222-2222-4222-8222-222222222222"
const TIMESTAMP = "2026-09-08 10:00:00.123456+00"
const source = {
  id: SOURCE,
  name: "Library Calendar",
  url: "https://example.com/events",
  source_type: "website",
  extraction_mode: "deterministic_then_llm",
  processing_mode: "manual_review",
  city_id: null,
  is_active: true,
  auto_approve: false,
  scrape_interval_hours: 24,
  last_scraped_at: null,
  last_status: "pending",
  error_count: 0,
  notes: null,
  date_window_days: 30,
  consecutive_zero_result_scrapes: 0,
  stale_escalated_at: null,
  created_at: TIMESTAMP,
  updated_at: TIMESTAMP,
}
const createBody = {
  name: "Library Calendar",
  url: "https://example.com/events",
  source_type: "website",
  extraction_mode: "deterministic_then_llm",
  processing_mode: "manual_review",
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
  { key: "list", method: "get", path: "/v1/admin/sources", body: undefined },
  { key: "create", method: "post", path: "/v1/admin/sources", body: createBody },
  {
    key: "update",
    method: "put",
    path: `/v1/admin/sources/${SOURCE}`,
    body: { notes: null },
  },
  {
    key: "scrape",
    method: "post",
    path: `/v1/admin/sources/${SOURCE}/scrape`,
    body: undefined,
  },
  {
    key: "setProcessingMode",
    method: "put",
    path: `/v1/admin/sources/${SOURCE}/processing-mode`,
    body: { mode: "llm_review" },
  },
  {
    key: "bulkSetProcessingMode",
    method: "post",
    path: "/v1/admin/sources/bulk-processing-mode",
    body: { mode: "manual_review" },
  },
] as const

describe("admin source HTTP with the real guard chain", () => {
  let app: INestApplication
  const repository = {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    scrape: vi.fn(),
    setProcessingMode: vi.fn(),
    bulkSetProcessingMode: vi.fn(),
  }

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ CLERK_SECRET_KEY: "sk_test_admin_source" })],
        }),
        DbModule,
        AdminModule,
      ],
    })
      .overrideProvider(IdentityService)
      .useValue(identity)
      .overrideProvider(DbService)
      .useValue({})
      .overrideProvider(AdminSourceRepository)
      .useValue(repository)
      .compile()
    app = module.createNestApplication()
    await app.init()
  })

  afterAll(async () => app.close())

  beforeEach(() => {
    vi.resetAllMocks()
    repository.list.mockResolvedValue([source])
    repository.create.mockResolvedValue(source)
    repository.update.mockResolvedValue(source)
    repository.scrape.mockResolvedValue({ queueId: "9007199254740993", deduped: false })
    repository.setProcessingMode.mockResolvedValue(source)
    repository.bulkSetProcessingMode.mockResolvedValue(undefined)
  })

  function untouched() {
    for (const method of Object.values(repository)) expect(method).not.toHaveBeenCalled()
  }

  for (const route of routes) {
    describe(`${route.method.toUpperCase()} ${route.path}`, () => {
      it.each([
        [undefined, 401, "Unauthorized", "missing bearer token"],
        ["invalid", 401, "Unauthorized", "invalid token"],
        ["unmapped", 403, "Forbidden", "user is not provisioned"],
        ["member", 404, undefined, "Not Found"],
      ])("rejects %s as %s before repository access", async (token, statusCode, error, message) => {
        const operation = request(app.getHttpServer())[route.method](route.path)
        if (token !== undefined) operation.set("Authorization", `Bearer ${token}`)
        if (route.body !== undefined) operation.send(route.body)
        const response = await operation
        expect(response.status).toBe(statusCode)
        expect(response.body).toEqual({ statusCode, message, ...(error ? { error } : {}) })
        untouched()
      })

      it("uses only the mapped operator actor", async () => {
        const http = request(app.getHttpServer())
        const operation = http[route.method](route.path)
          .set("Authorization", "Bearer operator")
          .set("X-Actor-Id", SOURCE)
        if (route.body !== undefined) operation.send(route.body)
        const response = await operation
        expect(response.status).toBe(200)
        const calls = Object.values(repository).flatMap((method) => method.mock.calls)
        expect(calls).toHaveLength(1)
        expect(calls[0]![0]).toBe(ACTOR)
        if (route.key === "list") expect(response.body).toEqual([source])
        else if (route.key === "scrape") {
          expect(response.body).toEqual({ queue_id: "9007199254740993", deduped: false })
        } else if (route.key === "bulkSetProcessingMode") {
          expect(response.body).toEqual({ ok: true })
        } else {
          expect(response.body).toEqual(source)
        }
      })

      it("maps database authorization denial to the stable 403", async () => {
        repository[route.key].mockRejectedValueOnce({
          code: "P0001",
          message: "ADMIN_SOURCE_ADMIN_REQUIRED",
        })
        const http = request(app.getHttpServer())
        const operation = http[route.method](route.path).set("Authorization", "Bearer operator")
        if (route.body !== undefined) operation.send(route.body)
        const response = await operation
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
    ["get", "/v1/admin/sources?actor_id=spoofed", undefined],
    ["post", "/v1/admin/sources", { ...createBody, actor_id: ACTOR }],
    ["post", "/v1/admin/sources", { ...createBody, url: "http://127.0.0.1" }],
    ["put", "/v1/admin/sources/not-a-uuid", { notes: null }],
    ["put", `/v1/admin/sources/${SOURCE}`, {}],
    ["put", `/v1/admin/sources/${SOURCE}`, { processing_mode: "auto_approve" }],
    ["post", `/v1/admin/sources/${SOURCE}/scrape`, { actor_id: ACTOR }],
    ["put", `/v1/admin/sources/${SOURCE}/processing-mode`, { mode: "invalid" }],
    ["post", "/v1/admin/sources/bulk-processing-mode", { mode: "manual_review", actor_id: ACTOR }],
  ] as const)("rejects invalid %s %s without repository access", async (method, path, body) => {
    const http = request(app.getHttpServer())
    const operation = http[method](path).set("Authorization", "Bearer operator")
    if (body !== undefined) operation.send(body)
    const response = await operation
    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({
      statusCode: 400,
      message: expect.any(String),
      error: "Bad Request",
      issues: expect.arrayContaining([{ path: expect.any(String), message: expect.any(String) }]),
    })
    untouched()
  })
})
