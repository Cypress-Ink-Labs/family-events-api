import { readFileSync } from "node:fs"

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

  it("documents the five admin operations with Clerk security and stable error responses", () => {
    const document = buildOpenApiDocument(app)
    const operations = [
      ["/v1/admin/events", "get", "adminListEvents"],
      ["/v1/admin/events/facets", "get", "adminEventFacets"],
      ["/v1/admin/events/{id}/status", "put", "adminSetEventStatus"],
      ["/v1/admin/events/bulk-status", "post", "adminBulkEventStatus"],
      ["/v1/admin/events/bulk-delete", "post", "adminBulkDeleteEvents"],
    ] as const
    expect(Object.keys(document.paths).filter((path) => path.startsWith("/v1/admin/"))).toEqual(
      operations.map(([path]) => path)
    )
    for (const [path, method, operationId] of operations) {
      const operation = document.paths[path]?.[method]
      expect(operation).toMatchObject({ operationId, tags: ["admin"], security: [{ clerk: [] }] })
      expect(Object.keys(operation?.responses ?? {})).toEqual(["200", "400", "401", "403", "404"])
    }
  })

  it("documents admin query constraints, precise values, nullable cursors, and bounded UUID arrays", () => {
    const document = buildOpenApiDocument(app)
    const parameters = document.paths["/v1/admin/events"]!.get!.parameters!
    const query = Object.fromEntries(
      parameters.flatMap((parameter) => ("name" in parameter ? [[parameter.name, parameter]] : []))
    )
    expect(Object.keys(query).toSorted()).toEqual([
      "after_created_at",
      "after_id",
      "city_id",
      "city_is_null",
      "keyword",
      "limit",
      "llm_review_decision",
      "llm_review_status",
      "llm_reviewed",
      "source_id",
      "status",
    ])
    expect(query.limit).toMatchObject({
      in: "query",
      required: false,
      schema: { type: "integer", minimum: 1, maximum: 500, default: 200 },
    })
    expect(query.keyword).toMatchObject({ schema: { type: "string", maxLength: 100 } })
    expect(query.status).toMatchObject({
      schema: { allOf: [{ $ref: "#/components/schemas/AdminStatus" }] },
    })
    expect(query.llm_review_status).toMatchObject({
      schema: { allOf: [{ $ref: "#/components/schemas/LlmReviewStatus" }] },
    })
    expect(query.llm_review_decision).toMatchObject({
      schema: { allOf: [{ $ref: "#/components/schemas/LlmReviewDecision" }] },
    })
    for (const name of ["after_id", "city_id", "source_id"]) {
      expect(query[name]).toMatchObject({ schema: { type: "string", format: "uuid" } })
    }
    for (const name of ["city_is_null", "llm_reviewed"]) {
      expect(query[name]).toMatchObject({ schema: { type: "boolean" } })
    }
    expect(query.after_created_at).toMatchObject({
      schema: { type: "string", format: "date-time" },
    })

    const schemas = document.components!.schemas!
    expect(schemas.AdminStatus).toMatchObject({
      type: "string",
      enum: ["draft", "published", "rejected", "archived"],
    })
    expect(schemas.LlmReviewStatus).toMatchObject({
      type: "string",
      enum: ["not_required", "pending", "succeeded", "failed", "skipped"],
    })
    expect(schemas.LlmReviewDecision).toMatchObject({
      type: "string",
      enum: ["approve", "reject", "needs_admin_review"],
    })
    expect(schemas.AdminEventDto).toMatchObject({
      properties: {
        ai_confidence: { type: "string", nullable: true },
        source_id: { type: "string", format: "uuid", nullable: true },
        llm_review_decision: { nullable: true, enum: ["approve", "reject", "needs_admin_review"] },
        created_at: { type: "string", format: "date-time" },
      },
    })
    expect(schemas.AdminEventsPageDto).toMatchObject({
      properties: {
        events: {
          type: "array",
          maxItems: 500,
          items: { $ref: "#/components/schemas/AdminEventDto" },
        },
        total_count: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        next_cursor: {
          nullable: true,
          allOf: [{ $ref: "#/components/schemas/AdminEventsCursorDto" }],
        },
      },
      required: ["events", "total_count", "next_cursor"],
    })
    expect(schemas.AdminEventsCursorDto).toMatchObject({
      properties: {
        after_created_at: { type: "string", format: "date-time" },
        after_id: { type: "string", format: "uuid" },
      },
      required: ["after_created_at", "after_id"],
    })
    expect(schemas.AdminStatusBodyDto).toMatchObject({
      properties: {
        reason: { type: "string", nullable: true, maxLength: 1000 },
      },
      required: ["status"],
    })
    for (const name of ["AdminBulkDeleteBodyDto", "AdminBulkStatusBodyDto"]) {
      expect(schemas[name]).toMatchObject({
        properties: {
          event_ids: {
            type: "array",
            minItems: 1,
            maxItems: 500,
            items: { type: "string", format: "uuid" },
          },
        },
      })
    }
    expect(schemas.AdminFacetDto).toMatchObject({
      properties: {
        count: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      },
    })
  })

  it("keeps the generated OpenAPI artifact in sync with the application", () => {
    const committed = JSON.parse(readFileSync("openapi.json", "utf8"))
    expect(JSON.parse(JSON.stringify(buildOpenApiDocument(app)))).toEqual(committed)
  })
})
