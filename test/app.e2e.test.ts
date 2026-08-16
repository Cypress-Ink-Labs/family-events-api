import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import request from "supertest"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AppModule } from "../src/app.module.js"
import { buildOpenApiDocument } from "../src/openapi.js"

/**
 * Boots the full Nest application (env validation, DI graph, controllers)
 * without external services: NODE_ENV=test skips pg-boss, and the DB pool
 * only connects lazily, so /readyz exercises the failure path.
 */
describe("application bootstrap", () => {
  let app: INestApplication

  beforeAll(async () => {
    // NODE_ENV/DATABASE_URL come from vitest.config.mts test.env.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  it("serves the liveness probe without touching the database", async () => {
    const response = await request(app.getHttpServer()).get("/healthz")
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ status: "ok" })
  })

  it("reports not-ready when the database is unreachable", async () => {
    const response = await request(app.getHttpServer()).get("/readyz")
    expect(response.status).toBe(503)
  })

  it("produces an OpenAPI document with the health paths", () => {
    const document = buildOpenApiDocument(app)
    expect(Object.keys(document.paths)).toEqual(expect.arrayContaining(["/healthz", "/readyz"]))
    expect(document.info.title).toBe("family-events-api")
  })
})
