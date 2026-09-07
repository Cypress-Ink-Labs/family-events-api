import type { INestApplication } from "@nestjs/common"
import { ConfigModule } from "@nestjs/config"
import { Test } from "@nestjs/testing"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { AdminModule } from "../src/admin/admin.module.js"
import { AdminReviewRepository } from "../src/admin/admin-review.repository.js"
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
const EVENT = "22222222-2222-4222-8222-222222222222"
const SOURCE = "33333333-3333-4333-8333-333333333333"
const CREATED = "2026-09-07 12:34:56.123456+00"
const event = {
  id: EVENT,
  title: "Review me",
  status: "draft",
  start_datetime: "2026-09-08 12:34:56.123456+00",
  venue_name: null,
  city_id: null,
  source_id: SOURCE,
  source_name: "Calendar",
  is_free: true,
  age_min: null,
  age_max: 12,
  ai_confidence: "0.12345678901234567890",
  llm_review_status: "pending",
  llm_review_decision: null,
  llm_review_reason: null,
  llm_review_error: null,
  created_at: CREATED,
}

const routes = [
  { method: "get", path: "/v1/admin/events", body: undefined },
  { method: "get", path: "/v1/admin/events/facets", body: undefined },
  { method: "put", path: `/v1/admin/events/${EVENT}/status`, body: { status: "published" } },
  {
    method: "post",
    path: "/v1/admin/events/bulk-status",
    body: { event_ids: [EVENT], status: "published" },
  },
  { method: "post", path: "/v1/admin/events/bulk-delete", body: { event_ids: [EVENT] } },
] as const

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

function testingModule() {
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => ({ CLERK_SECRET_KEY: "sk_test_admin" })],
      }),
      DbModule,
      AdminModule,
    ],
  })
    .overrideProvider(IdentityService)
    .useValue(identity)
}

describe("admin review HTTP with the real guard chain", () => {
  let app: INestApplication
  const repository = {
    listEvents: vi.fn(),
    facets: vi.fn(),
    setStatus: vi.fn(),
    bulkStatus: vi.fn(),
    bulkDelete: vi.fn(),
  }

  beforeAll(async () => {
    const module = await testingModule()
      .overrideProvider(DbService)
      .useValue({})
      .overrideProvider(AdminReviewRepository)
      .useValue(repository)
      .compile()
    app = module.createNestApplication()
    await app.init()
  })

  afterAll(async () => app.close())

  beforeEach(() => {
    vi.clearAllMocks()
    for (const method of Object.values(repository)) method.mockReset()
    repository.listEvents.mockResolvedValue([
      {
        ...event,
        total_count: "1",
        description: "private unused RPC field",
        admin_last_edited_by: ACTOR,
      },
    ])
    repository.facets.mockResolvedValue([
      { city_id: null, source_id: SOURCE, status: "draft", count: "1", extra: "unused" },
    ])
    repository.setStatus.mockResolvedValue(1)
    repository.bulkStatus.mockResolvedValue(1)
    repository.bulkDelete.mockResolvedValue(1)
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
        if (token === undefined || token === "invalid")
          expect(identity.resolve).not.toHaveBeenCalled()
      })

      it("allows an operator and uses the mapped actor UUID", async () => {
        const http = request(app.getHttpServer())
        const operation = http[route.method](route.path)
          .set("Authorization", "Bearer operator")
          .set("X-Actor-Id", SOURCE)
        if (route.body !== undefined) operation.send(route.body)
        const response = await operation
        expect(response.status).toBe(200)
        expect(identity.resolve).toHaveBeenCalledWith("user_operator")
        const calls = Object.values(repository).flatMap((method) => method.mock.calls)
        expect(calls.length).toBeGreaterThan(0)
        for (const call of calls) expect(call[0]).toBe(ACTOR)
        if (route.path.endsWith("/facets")) {
          expect(response.body).toEqual([
            { city_id: null, source_id: SOURCE, status: "draft", count: 1 },
          ])
        } else if (route.path === "/v1/admin/events") {
          expect(response.body).toEqual({ events: [event], total_count: 1, next_cursor: null })
        } else {
          expect(response.body).toEqual({ ok: true, affected: 1 })
        }
      })

      it.each([
        { code: "42501", message: "forbidden" },
        { code: "P0001", message: "ADMIN_EVENT_ADMIN_REQUIRED" },
      ])("conceals database admin denial as 404: $message", async (failure) => {
        for (const method of Object.values(repository)) method.mockRejectedValueOnce(failure)
        const http = request(app.getHttpServer())
        const operation = http[route.method](route.path).set("Authorization", "Bearer operator")
        if (route.body !== undefined) operation.send(route.body)
        const response = await operation
        expect(response.status).toBe(404)
        expect(response.body).toEqual({ statusCode: 404, message: "Not Found" })
      })
    })
  }

  it.each([
    ["get", "/v1/admin/events?actor_id=spoofed", undefined],
    ["get", "/v1/admin/events?limit=501", undefined],
    ["get", `/v1/admin/events?after_id=${EVENT}`, undefined],
    ["get", "/v1/admin/events?city_is_null=1", undefined],
    ["get", "/v1/admin/events?status=all", undefined],
    ["get", "/v1/admin/events/facets?source_id=spoofed", undefined],
    ["get", `/v1/admin/events/facets?keyword=${"x".repeat(101)}`, undefined],
    ["put", "/v1/admin/events/not-a-uuid/status", { status: "draft" }],
    ["put", `/v1/admin/events/${EVENT}/status`, { status: "draft", actor_id: SOURCE }],
    ["put", `/v1/admin/events/${EVENT}/status`, { status: "draft", reason: "x".repeat(1001) }],
    ["post", "/v1/admin/events/bulk-status", { event_ids: [], status: "draft" }],
    ["post", "/v1/admin/events/bulk-status", { event_ids: [EVENT], status: "invalid" }],
    ["post", "/v1/admin/events/bulk-delete", { event_ids: Array(501).fill(EVENT) }],
    ["post", "/v1/admin/events/bulk-delete", { event_ids: [EVENT, "bad-id"] }],
    ["post", "/v1/admin/events/bulk-delete", { event_ids: [EVENT], actor_id: SOURCE }],
  ] as const)("rejects invalid %s %s without repository access", async (method, path, body) => {
    const http = request(app.getHttpServer())
    const operation = http[method](path).set("Authorization", "Bearer operator")
    if (body !== undefined) operation.send(body)
    const response = await operation
    expect(response.status).toBe(400)
    expect(response.body).toEqual({
      statusCode: 400,
      message: expect.any(String),
      error: "Bad Request",
      issues: expect.arrayContaining([{ path: expect.any(String), message: expect.any(String) }]),
    })
    untouched()
  })

  it("passes all parsed filters and the original microsecond cursor to the repository", async () => {
    await request(app.getHttpServer())
      .get("/v1/admin/events")
      .set("Authorization", "Bearer operator")
      .query({
        status: "draft",
        city_id: SOURCE,
        city_is_null: "false",
        keyword: "  family  ",
        after_created_at: CREATED,
        after_id: EVENT,
        limit: "1",
        llm_review_status: "pending",
        llm_review_decision: "approve",
        llm_reviewed: "false",
        source_id: SOURCE,
      })
      .expect(200)
    expect(repository.listEvents).toHaveBeenCalledWith(ACTOR, {
      status: "draft",
      cityId: SOURCE,
      cityIsNull: false,
      keyword: "family",
      afterCreatedAt: CREATED,
      afterId: EVENT,
      limit: 2,
      llmReviewStatus: "pending",
      llmReviewDecision: "approve",
      llmReviewed: false,
      sourceId: SOURCE,
    })
  })

  it("trims single-status reasons and deduplicates submitted batch IDs", async () => {
    await request(app.getHttpServer())
      .put(`/v1/admin/events/${EVENT}/status`)
      .set("Authorization", "Bearer operator")
      .send({ status: "rejected", reason: "  duplicate listing  " })
      .expect(200)
    expect(repository.setStatus).toHaveBeenCalledWith(ACTOR, EVENT, "rejected", "duplicate listing")
    await request(app.getHttpServer())
      .post("/v1/admin/events/bulk-status")
      .set("Authorization", "Bearer operator")
      .send({ event_ids: [EVENT, EVENT], status: "archived" })
      .expect(200)
    expect(repository.bulkStatus).toHaveBeenCalledWith(ACTOR, [EVENT], "archived")
    repository.bulkDelete.mockResolvedValueOnce(0)
    const response = await request(app.getHttpServer())
      .post("/v1/admin/events/bulk-delete")
      .set("Authorization", "Bearer operator")
      .send({ event_ids: [EVENT, EVENT] })
      .expect(200)
    expect(repository.bulkDelete).toHaveBeenCalledWith(ACTOR, [EVENT])
    expect(response.body).toEqual({ ok: true, affected: 0 })
  })

  it("projects a lookahead cursor without losing timestamp precision", async () => {
    repository.listEvents.mockResolvedValueOnce([
      { ...event, total_count: "2" },
      { ...event, id: SOURCE, total_count: "2" },
    ])
    const response = await request(app.getHttpServer())
      .get("/v1/admin/events?limit=1")
      .set("Authorization", "Bearer operator")
      .expect(200)
    expect(response.body).toEqual({
      events: [event],
      total_count: 2,
      next_cursor: { after_created_at: CREATED, after_id: EVENT },
    })
  })

  it("returns the stable 404 response for a missing single-status event", async () => {
    repository.setStatus.mockRejectedValueOnce({ code: "P0002", message: "event not found" })
    const response = await request(app.getHttpServer())
      .put(`/v1/admin/events/${EVENT}/status`)
      .set("Authorization", "Bearer operator")
      .send({ status: "published" })
      .expect(404)
    expect(response.body).toEqual({ statusCode: 404, message: "Not Found" })
  })
})
