import type { INestApplication } from "@nestjs/common"
import { ConfigModule } from "@nestjs/config"
import { Test } from "@nestjs/testing"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { AdminEventEditorRepository } from "../src/admin/admin-event-editor.repository.js"
import { AdminModule } from "../src/admin/admin.module.js"
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
const TAG = "33333333-3333-4333-8333-333333333333"
const TIMESTAMP = "2026-09-08 10:00:00.123456+00"
const detail = {
  event: {
    id: EVENT,
    title: "Story time",
    description: null,
    start_datetime: TIMESTAMP,
    end_datetime: null,
    timezone: "America/Chicago",
    venue_name: null,
    address: null,
    city_id: null,
    latitude: "30.1234567",
    longitude: "-91.1234567",
    age_min: null,
    age_max: 12,
    price: null,
    is_free: true,
    is_outdoor: null,
    source_url: "https://example.com/event",
    source_name: "Calendar",
    source_id: null,
    images: [],
    status: "draft",
    recurrence_info: null,
    is_featured: false,
    admin_locked_fields: ["description"],
    admin_last_edited_at: TIMESTAMP,
    admin_last_edited_by: ACTOR,
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
  },
  tags: [
    {
      id: TAG,
      name: "Storytime",
      slug: "storytime",
      color: "#123456",
      confidence: "1.000",
      is_manual_override: true,
    },
  ],
  availableTags: [{ id: TAG, name: "Storytime", slug: "storytime", color: "#123456" }],
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
  { method: "get", path: `/v1/admin/events/${EVENT}`, body: undefined },
  {
    method: "put",
    path: `/v1/admin/events/${EVENT}`,
    body: { patch: { description: null }, tag_ids: [TAG] },
  },
  { method: "post", path: `/v1/admin/events/${EVENT}/unlock`, body: undefined },
] as const

describe("admin event editor HTTP with the real guard chain", () => {
  let app: INestApplication
  const repository = {
    get: vi.fn(),
    update: vi.fn(),
    unlock: vi.fn(),
  }

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ CLERK_SECRET_KEY: "sk_test_admin_editor" })],
        }),
        DbModule,
        AdminModule,
      ],
    })
      .overrideProvider(IdentityService)
      .useValue(identity)
      .overrideProvider(DbService)
      .useValue({})
      .overrideProvider(AdminEventEditorRepository)
      .useValue(repository)
      .compile()
    app = module.createNestApplication()
    await app.init()
  })

  afterAll(async () => app.close())

  beforeEach(() => {
    vi.clearAllMocks()
    repository.get.mockResolvedValue(detail)
    repository.update.mockResolvedValue(detail)
    repository.unlock.mockResolvedValue(1)
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

      it("allows a mapped operator and ignores a forged actor header", async () => {
        const http = request(app.getHttpServer())
        const operation = http[route.method](route.path)
          .set("Authorization", "Bearer operator")
          .set("X-Actor-Id", TAG)
        if (route.body !== undefined) operation.send(route.body)
        const response = await operation
        expect(response.status).toBe(200)
        const calls = Object.values(repository).flatMap((method) => method.mock.calls)
        expect(calls).toHaveLength(1)
        expect(calls[0]![0]).toBe(ACTOR)
        if (route.path.endsWith("/unlock")) {
          expect(response.body).toEqual({ ok: true, affected: 1 })
        } else {
          expect(response.body).toEqual({
            event: detail.event,
            tags: detail.tags,
            available_tags: detail.availableTags,
          })
        }
      })

      it("maps database access denial to the stable 403", async () => {
        const method =
          route.method === "get"
            ? repository.get
            : route.method === "put"
              ? repository.update
              : repository.unlock
        method.mockRejectedValueOnce({ code: "P0001", message: "ADMIN_EVENT_ADMIN_REQUIRED" })
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
    ["get", "/v1/admin/events/not-a-uuid", undefined],
    ["put", "/v1/admin/events/not-a-uuid", { patch: {}, tag_ids: [] }],
    ["put", `/v1/admin/events/${EVENT}`, { patch: {} }],
    ["put", `/v1/admin/events/${EVENT}`, { patch: { id: EVENT }, tag_ids: [] }],
    ["put", `/v1/admin/events/${EVENT}`, { patch: {}, tag_ids: [], actor_id: ACTOR }],
    ["post", "/v1/admin/events/not-a-uuid/unlock", undefined],
    ["post", `/v1/admin/events/${EVENT}/unlock`, { actor_id: ACTOR }],
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

  it("preserves explicit null while omitting absent patch fields", async () => {
    await request(app.getHttpServer())
      .put(`/v1/admin/events/${EVENT}`)
      .set("Authorization", "Bearer operator")
      .send({
        patch: { description: null, venue_name: "Library" },
        tag_ids: [],
        lock_edited_fields: false,
        decision_reason: "  corrected  ",
      })
      .expect(200)
    expect(repository.update).toHaveBeenCalledWith(ACTOR, EVENT, {
      patch: { description: null, venueName: "Library" },
      tagIds: [],
      lockEditedFields: false,
      decisionReason: "corrected",
    })
  })
})
