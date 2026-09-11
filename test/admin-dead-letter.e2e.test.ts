import type { INestApplication } from "@nestjs/common"
import { ConfigModule } from "@nestjs/config"
import { Test } from "@nestjs/testing"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { AdminDeadLetterRepository } from "../src/admin/admin-dead-letter.repository.js"
import { AdminModule } from "../src/admin/admin.module.js"
import { IdentityService } from "../src/auth/identity.service.js"
import { DbModule } from "../src/db/db.module.js"
import { DbService } from "../src/db/db.service.js"

vi.mock("@clerk/backend", () => ({
  verifyToken: vi.fn(async (token: string) => {
    if (["operator", "member", "unmapped"].includes(token)) return { sub: `user_${token}` }
    throw new Error("invalid")
  }),
}))

const ACTOR = "11111111-1111-4111-8111-111111111111"
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

describe("admin dead-letter HTTP with the real guard chain", () => {
  let app: INestApplication
  const repository = { list: vi.fn(), retry: vi.fn(), remove: vi.fn() }
  const routes = [
    ["get", "/v1/admin/dead-letters?queue=source"],
    ["post", "/v1/admin/dead-letters/source/9007199254740993/retry"],
    ["delete", "/v1/admin/dead-letters/tag/9007199254740993"],
  ] as const

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ CLERK_SECRET_KEY: "sk_test_dead_letter" })],
        }),
        DbModule,
        AdminModule,
      ],
    })
      .overrideProvider(IdentityService)
      .useValue(identity)
      .overrideProvider(DbService)
      .useValue({})
      .overrideProvider(AdminDeadLetterRepository)
      .useValue(repository)
      .compile()
    app = module.createNestApplication()
    await app.init()
  })
  afterAll(async () => app.close())
  beforeEach(() => {
    vi.resetAllMocks()
    repository.list.mockResolvedValue([])
    repository.retry.mockResolvedValue({
      disposition: "queued",
      resultingQueueId: "9007199254740994",
    })
    repository.remove.mockResolvedValue(true)
  })

  for (const [method, path] of routes) {
    it.each([
      [undefined, 401],
      ["unmapped", 403],
      ["member", 404],
    ])(`${method.toUpperCase()} ${path} rejects %s before data access`, async (token, status) => {
      const operation = request(app.getHttpServer())[method](path)
      if (token !== undefined) operation.set("Authorization", `Bearer ${token}`)
      expect((await operation).status).toBe(status)
      expect(repository.list).not.toHaveBeenCalled()
      expect(repository.retry).not.toHaveBeenCalled()
      expect(repository.remove).not.toHaveBeenCalled()
    })
  }

  it("lists with the mapped actor", async () => {
    const response = await request(app.getHttpServer())
      .get(routes[0][1])
      .set("Authorization", "Bearer operator")
      .set("X-Actor-Id", "spoof")
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ items: [], next_cursor: null })
    expect(repository.list).toHaveBeenCalledWith(
      ACTOR,
      expect.objectContaining({ queue: "source", limit: 25 })
    )
  })

  it("retries and deletes successfully", async () => {
    const retry = await request(app.getHttpServer())
      .post(routes[1][1])
      .set("Authorization", "Bearer operator")
      .send({})
    expect(retry.status).toBe(200)
    expect(retry.body).toEqual({ status: "queued", resulting_queue_id: "9007199254740994" })
    expect(repository.retry).toHaveBeenCalledWith(ACTOR, "source", "9007199254740993")
    const remove = await request(app.getHttpServer())
      .delete(routes[2][1])
      .set("Authorization", "Bearer operator")
      .send({})
    expect(remove.status).toBe(200)
    expect(remove.body).toEqual({ ok: true })
  })

  it.each([
    ["get", "/v1/admin/dead-letters", undefined],
    ["get", "/v1/admin/dead-letters?queue=review", undefined],
    ["post", "/v1/admin/dead-letters/source/0/retry", {}],
    ["post", "/v1/admin/dead-letters/source/1/retry", { actor: "spoof" }],
    ["delete", "/v1/admin/dead-letters/tag/9223372036854775808", {}],
  ] as const)("rejects invalid input without repository access", async (method, path, body) => {
    const operation = request(app.getHttpServer())
      [method](path)
      .set("Authorization", "Bearer operator")
    if (body !== undefined) operation.send(body)
    expect((await operation).status).toBe(400)
    expect(repository.list).not.toHaveBeenCalled()
    expect(repository.retry).not.toHaveBeenCalled()
    expect(repository.remove).not.toHaveBeenCalled()
  })

  it.each([
    ["retry", "post", routes[1][1]],
    ["remove", "delete", routes[2][1]],
  ] as const)("maps missing %s rows to 404", async (key, method, path) => {
    repository[key].mockResolvedValueOnce(key === "retry" ? null : false)
    expect(
      (
        await request(app.getHttpServer())
          [method](path)
          .set("Authorization", "Bearer operator")
          .send({})
      ).status
    ).toBe(404)
  })
})
