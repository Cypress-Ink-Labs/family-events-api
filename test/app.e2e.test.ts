import { readFileSync } from "node:fs"

import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import request from "supertest"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { AppModule } from "../src/app.module.js"
import { buildOpenApiDocument } from "../src/openapi.js"

interface ContractSchema {
  $ref?: string
  type?: string
  nullable?: boolean
  enum?: unknown[]
  allOf?: ContractSchema[]
  oneOf?: ContractSchema[]
  properties?: Record<string, ContractSchema>
  required?: string[]
  additionalProperties?: boolean | ContractSchema
  items?: ContractSchema
  minItems?: number
  maxItems?: number
  minProperties?: number
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  format?: string
  description?: string
  default?: unknown
}

// Exercise the emitted OAS 3.0 constraints, including composition across nullable refs.
function matchesContract(
  value: unknown,
  schema: ContractSchema,
  schemas: Record<string, ContractSchema>
): boolean {
  const supportedKeywords = new Set([
    "$ref",
    "type",
    "nullable",
    "enum",
    "allOf",
    "oneOf",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "minItems",
    "maxItems",
    "minProperties",
    "minimum",
    "maximum",
    "minLength",
    "maxLength",
    "format",
    "description",
    "default",
  ])
  const unsupported = Object.keys(schema).filter((key) => !supportedKeywords.has(key))
  if (unsupported.length > 0) {
    throw new Error(`unsupported contract keyword: ${unsupported.join(", ")}`)
  }
  if (schema.$ref) {
    const target = schemas[schema.$ref.replace("#/components/schemas/", "")]
    if (!target) throw new Error(`unresolved schema ${schema.$ref}`)
    return matchesContract(value, target, schemas)
  }
  if (schema.allOf && !schema.allOf.every((part) => matchesContract(value, part, schemas)))
    return false
  if (
    schema.oneOf &&
    schema.oneOf.filter((part) => matchesContract(value, part, schemas)).length !== 1
  )
    return false
  if (schema.enum && !schema.enum.includes(value)) return false
  if (value === null) return schema.type === undefined || schema.nullable === true
  if (schema.type === "object") {
    if (typeof value !== "object" || Array.isArray(value)) return false
    const object = value as Record<string, unknown>
    if (schema.minProperties !== undefined && Object.keys(object).length < schema.minProperties)
      return false
    if (schema.required?.some((key) => !Object.hasOwn(object, key))) return false
    return Object.entries(object).every(([key, field]) => {
      const property = schema.properties?.[key]
      if (property) return matchesContract(field, property, schemas)
      if (schema.additionalProperties === false) return false
      return (
        typeof schema.additionalProperties !== "object" ||
        matchesContract(field, schema.additionalProperties, schemas)
      )
    })
  }
  if (schema.type === "array") {
    return (
      Array.isArray(value) &&
      (schema.minItems === undefined || value.length >= schema.minItems) &&
      (schema.maxItems === undefined || value.length <= schema.maxItems) &&
      (schema.items === undefined ||
        value.every((item) => matchesContract(item, schema.items!, schemas)))
    )
  }
  if (schema.type === "string") {
    if (
      typeof value !== "string" ||
      (schema.minLength !== undefined && value.length < schema.minLength) ||
      (schema.maxLength !== undefined && value.length > schema.maxLength)
    )
      return false
    if (
      schema.format !== undefined &&
      schema.format !== "uuid" &&
      schema.format !== "date-time" &&
      schema.format !== "uri" &&
      schema.format !== "email"
    ) {
      throw new Error(`unsupported string format: ${schema.format}`)
    }
    if (
      schema.format === "uuid" &&
      !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value)
    )
      return false
    if (
      schema.format === "date-time" &&
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    )
      return false
    if (schema.format === "uri" && !URL.canParse(value)) return false
    if (schema.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return false
    return true
  }
  if (schema.type === "integer" || schema.type === "number") {
    return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      (schema.type !== "integer" || Number.isInteger(value)) &&
      (schema.minimum === undefined || value >= schema.minimum) &&
      (schema.maximum === undefined || value <= schema.maximum)
    )
  }
  if (schema.type === "boolean") return typeof value === "boolean"
  if (
    schema.type === undefined &&
    (schema.allOf !== undefined || schema.oneOf !== undefined || schema.enum !== undefined)
  ) {
    return true
  }
  throw new Error(
    schema.type === undefined
      ? "contract schema requires a type, reference, composition, or enum"
      : `unsupported contract type: ${schema.type}`
  )
}

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

  it("documents admin operations with Clerk security and stable errors", () => {
    const document = buildOpenApiDocument(app)
    const operations = [
      ["/v1/admin/events", "get", "adminListEvents"],
      ["/v1/admin/events/facets", "get", "adminEventFacets"],
      ["/v1/admin/events/{id}/status", "put", "adminSetEventStatus"],
      ["/v1/admin/events/bulk-status", "post", "adminBulkEventStatus"],
      ["/v1/admin/events/bulk-delete", "post", "adminBulkDeleteEvents"],
      ["/v1/admin/events/{id}", "get", "adminGetEvent"],
      ["/v1/admin/events/{id}", "put", "adminUpdateEvent"],
      ["/v1/admin/events/{id}/unlock", "post", "adminUnlockEventFields"],
      ["/v1/admin/sources", "get", "adminListSources"],
      ["/v1/admin/sources", "post", "adminCreateSource"],
      ["/v1/admin/sources/{id}", "put", "adminUpdateSource"],
      ["/v1/admin/sources/{id}/scrape", "post", "adminScrapeSource"],
      ["/v1/admin/sources/{id}/processing-mode", "put", "adminSetSourceProcessingMode"],
      ["/v1/admin/sources/bulk-processing-mode", "post", "adminBulkSetSourceProcessingMode"],
      ["/v1/admin/users", "get", "adminListUsers"],
      ["/v1/admin/users/{id}/access", "put", "adminSetUserAccess"],
      ["/v1/admin/users/{id}", "delete", "adminDeleteUser"],
      ["/v1/admin/invites/required", "get", "adminGetInvitesRequired"],
      ["/v1/admin/invite-codes", "get", "adminListInviteCodes"],
      ["/v1/admin/invite-codes", "post", "adminCreateInviteCode"],
      ["/v1/admin/invite-codes/{id}", "delete", "adminRevokeInviteCode"],
      ["/v1/admin/invite-requests", "get", "adminListInviteRequests"],
      ["/v1/admin/invite-requests/{id}/approve", "post", "adminApproveInviteRequest"],
      ["/v1/admin/invite-requests/{id}/reject", "post", "adminRejectInviteRequest"],
      ["/v1/admin/dashboard/stats", "get", "adminDashboardStats"],
      ["/v1/admin/statistics/pipeline", "get", "adminPipelineStats"],
    ] as const
    expect(Object.keys(document.paths).filter((path) => path.startsWith("/v1/admin/"))).toEqual([
      ...new Set(operations.map(([path]) => path)),
    ])
    for (const [path, method, operationId] of operations) {
      const operation = document.paths[path]?.[method]
      expect(operation).toMatchObject({ operationId, tags: ["admin"], security: [{ clerk: [] }] })
      expect(Object.keys(operation?.responses ?? {})).toEqual(["200", "400", "401", "403", "404"])
      for (const status of ["400", "401", "403", "404"]) {
        expect(operation?.responses[status]).toMatchObject({
          content: {
            "application/json": {
              schema: {
                $ref: `#/components/schemas/${status === "400" ? "AdminValidationErrorDto" : "AdminErrorDto"}`,
              },
            },
          },
        })
      }
    }
    expect(document.paths["/v1/admin/statistics/pipeline"]!.get!.parameters).toEqual([
      expect.objectContaining({
        name: "window_days",
        in: "query",
        required: false,
        schema: expect.objectContaining({ type: "number", minimum: 1, maximum: 365 }),
      }),
    ])
    expect(document.components!.schemas!.AdminTopRejectionSourceDto).toMatchObject({
      properties: {
        source_name: { type: "string", nullable: true },
        rejection_rate: { type: "number", minimum: 0, maximum: 100 },
      },
    })
    expect(document.components!.schemas!.AdminDashboardStatsDto).toMatchObject({
      properties: {
        generated_at: {
          type: "string",
          description: expect.stringContaining("microsecond precision"),
        },
      },
    })
    expect(document.components!.schemas!.AdminPipelineStatsDto).toMatchObject({
      properties: {
        top_rejection_sources: {
          type: "array",
          maxItems: 10,
          items: { $ref: "#/components/schemas/AdminTopRejectionSourceDto" },
        },
        feature_flags: {
          type: "object",
          additionalProperties: { type: "boolean" },
        },
      },
    })
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
      schema: { type: "string" },
    })
    expect(query.after_created_at?.schema).not.toHaveProperty("format")

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
        llm_review_decision: {
          nullable: true,
          enum: ["approve", "reject", "needs_admin_review", null],
        },
        created_at: { type: "string" },
        start_datetime: { type: "string" },
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
          oneOf: [
            { $ref: "#/components/schemas/AdminEventsCursorDto" },
            { type: "object", nullable: true, enum: [null] },
          ],
        },
      },
      required: ["events", "total_count", "next_cursor"],
    })
    expect(schemas.AdminEventsCursorDto).toMatchObject({
      properties: {
        after_created_at: { type: "string" },
        after_id: { type: "string", format: "uuid" },
      },
      required: ["after_created_at", "after_id"],
    })
    const statusBody = document.paths["/v1/admin/events/{id}/status"]!.put!.requestBody!
    if (!("content" in statusBody)) throw new Error("expected inline status body")
    expect(statusBody.content["application/json"]!.schema).toMatchObject({
      additionalProperties: false,
      properties: {
        reason: { type: "string", nullable: true, maxLength: 1000 },
      },
      required: ["status"],
    })
    for (const path of ["/v1/admin/events/bulk-delete", "/v1/admin/events/bulk-status"]) {
      const body = document.paths[path]!.post!.requestBody!
      if (!("content" in body)) throw new Error("expected inline batch body")
      expect(body.content["application/json"]!.schema).toMatchObject({
        additionalProperties: false,
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
    expect(schemas.AdminEditableEventDto).toMatchObject({
      properties: {
        latitude: { type: "string", nullable: true },
        longitude: { type: "string", nullable: true },
        price: { type: "string", nullable: true },
        start_datetime: { type: "string" },
        end_datetime: { type: "string", nullable: true },
        recurrence_info: { oneOf: expect.any(Array) },
      },
    })
    for (const field of ["start_datetime", "end_datetime", "created_at", "updated_at"]) {
      expect(
        (schemas.AdminEditableEventDto as ContractSchema).properties![field]!
      ).not.toHaveProperty("format")
    }
    const editorBody = document.paths["/v1/admin/events/{id}"]!.put!.requestBody!
    if (!("content" in editorBody)) throw new Error("expected inline event editor body")
    expect(editorBody.content["application/json"]!.schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["patch", "tag_ids"],
      properties: {
        patch: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string", minLength: 1, maxLength: 500 },
            description: { type: "string", nullable: true, maxLength: 10_000 },
            images: { type: "array", maxItems: 20 },
          },
        },
        tag_ids: {
          type: "array",
          maxItems: 500,
          items: { type: "string", format: "uuid" },
        },
        decision_reason: { type: "string", nullable: true, maxLength: 1000 },
      },
    })
    expect(schemas.AdminSourceDto).toMatchObject({
      properties: {
        processing_mode: {
          type: "string",
          enum: ["manual_review", "auto_approve", "llm_review"],
        },
        last_status: {
          nullable: true,
          enum: ["pending", "success", "error", "partial", "stale", null],
        },
        last_scraped_at: { type: "string", nullable: true },
        stale_escalated_at: { type: "string", nullable: true },
      },
    })
    for (const field of ["last_scraped_at", "stale_escalated_at", "created_at", "updated_at"]) {
      expect((schemas.AdminSourceDto as ContractSchema).properties![field]!).not.toHaveProperty(
        "format"
      )
    }
    const createSourceBody = document.paths["/v1/admin/sources"]!.post!.requestBody!
    if (!("content" in createSourceBody)) throw new Error("expected inline create source body")
    expect(createSourceBody.content["application/json"]!.schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["name", "url", "source_type", "extraction_mode", "processing_mode"],
      properties: {
        url: { type: "string", format: "uri", maxLength: 2048 },
        is_active: { type: "boolean", default: true },
        scrape_interval_hours: { type: "integer", minimum: 1, maximum: 8760, default: 24 },
      },
    })
    const updateSourceBody = document.paths["/v1/admin/sources/{id}"]!.put!.requestBody!
    if (!("content" in updateSourceBody)) throw new Error("expected inline update source body")
    expect(updateSourceBody.content["application/json"]!.schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      minProperties: 1,
    })
    expect(schemas.AdminUserAccessDto).toMatchObject({
      properties: {
        user_id: { type: "string", format: "uuid" },
        role: { type: "string", enum: ["user", "admin"], nullable: true },
        access_expires_at: { type: "string", nullable: true },
        disabled_at: { type: "string", nullable: true },
      },
    })
    for (const field of [
      "access_expires_at",
      "enabled_at",
      "disabled_at",
      "profile_created_at",
      "created_at",
      "updated_at",
    ]) {
      expect((schemas.AdminUserAccessDto as ContractSchema).properties![field]!).not.toHaveProperty(
        "format"
      )
    }
    const accessBody = document.paths["/v1/admin/users/{id}/access"]!.put!.requestBody!
    if (!("content" in accessBody)) throw new Error("expected inline user access body")
    expect(accessBody.content["application/json"]!.schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["is_enabled"],
      properties: {
        disabled_reason: { type: "string", nullable: true, maxLength: 1000 },
      },
    })
    expect(schemas.AdminInviteCodeDto).toMatchObject({
      properties: {
        max_uses: { type: "integer", minimum: 1, maximum: 10000 },
        used_count: { type: "integer", minimum: 0 },
        expires_at: { type: "string", nullable: true },
        revoked_at: { type: "string", nullable: true },
      },
    })
    expect(schemas.AdminInviteCodeDto).not.toHaveProperty("properties.code")
    expect(schemas.AdminInviteCodeDto).not.toHaveProperty("properties.code_hash")
    expect(schemas.AdminCreatedInviteCodeDto).toHaveProperty("properties.code")
    const createInviteBody = document.paths["/v1/admin/invite-codes"]!.post!.requestBody!
    if (!("content" in createInviteBody)) throw new Error("expected inline invite-code body")
    expect(createInviteBody.content["application/json"]!.schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["max_uses"],
      properties: {
        max_uses: { type: "integer", minimum: 1, maximum: 10000 },
        expires_at: { type: "string", format: "date-time", nullable: true },
      },
    })
    expect(schemas.AdminInviteRequestDto).toMatchObject({
      properties: {
        email: { type: "string", format: "email" },
        status: { enum: ["pending", "approved", "rejected"] },
        reviewed_at: { type: "string", nullable: true },
      },
    })
    expect(schemas.AdminApprovedInviteRequestDto).toHaveProperty("properties.code")
    const rejectInviteBody =
      document.paths["/v1/admin/invite-requests/{id}/reject"]!.post!.requestBody!
    if (!("content" in rejectInviteBody)) throw new Error("expected inline invite rejection body")
    expect(rejectInviteBody.content["application/json"]!.schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: { notes: { type: "string", nullable: true, maxLength: 1000 } },
    })
  })

  it("validates raw timestamp strings, null decisions, and both cursor variants against OpenAPI", () => {
    const document = buildOpenApiDocument(app)
    const schemas = document.components!.schemas! as Record<string, ContractSchema>
    const id = "22222222-2222-4222-8222-222222222222"
    const timestamp = "2026-09-07 12:34:56.123456+00"
    const event = {
      id,
      title: "Review me",
      status: "draft",
      start_datetime: timestamp,
      venue_name: null,
      city_id: null,
      source_id: null,
      source_name: null,
      is_free: true,
      age_min: null,
      age_max: null,
      ai_confidence: "0.12345678901234567890",
      llm_review_status: "pending",
      llm_review_decision: null,
      llm_review_reason: null,
      llm_review_error: null,
      created_at: timestamp,
    }
    const page = { events: [event], total_count: 1, next_cursor: null }
    const cursor = { after_created_at: timestamp, after_id: id }
    const pageSchema = schemas.AdminEventsPageDto!
    expect(matchesContract(page, pageSchema, schemas)).toBe(true)
    expect(matchesContract({ ...page, next_cursor: cursor }, pageSchema, schemas)).toBe(true)
    expect(matchesContract({ ...page, next_cursor: {} }, pageSchema, schemas)).toBe(false)
    expect(
      matchesContract(
        { ...page, next_cursor: { ...cursor, after_id: "invalid" } },
        pageSchema,
        schemas
      )
    ).toBe(false)
    expect(
      matchesContract({ ...event, llm_review_decision: "invalid" }, schemas.AdminEventDto!, schemas)
    ).toBe(false)
    expect(
      matchesContract({ ...event, ai_confidence: 0.123 }, schemas.AdminEventDto!, schemas)
    ).toBe(false)
    expect(matchesContract({ ...event, created_at: null }, schemas.AdminEventDto!, schemas)).toBe(
      false
    )
    for (const [name, field] of [
      ["AdminEventDto", "created_at"],
      ["AdminEventDto", "start_datetime"],
      ["AdminEventsCursorDto", "after_created_at"],
    ]) {
      expect(schemas[name!]!.properties![field!]!).not.toHaveProperty("format")
    }
    const cursorQuery = document.paths["/v1/admin/events"]!.get!.parameters!.find(
      (parameter) => "name" in parameter && parameter.name === "after_created_at"
    )!
    if (!("schema" in cursorQuery)) throw new Error("missing cursor query schema")
    expect(matchesContract(timestamp, cursorQuery.schema!, schemas)).toBe(true)
    const editable = {
      id,
      title: "Review me",
      description: null,
      start_datetime: timestamp,
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
      source_url: null,
      source_name: null,
      source_id: null,
      images: [],
      status: "draft",
      recurrence_info: null,
      is_featured: false,
      admin_locked_fields: [],
      admin_last_edited_at: null,
      admin_last_edited_by: null,
      created_at: timestamp,
      updated_at: timestamp,
    }
    const editorDetail = {
      event: editable,
      tags: [],
      available_tags: [],
    }
    expect(matchesContract(editorDetail, schemas.AdminEventEditorDetailDto!, schemas)).toBe(true)
    expect(
      matchesContract(
        { ...editorDetail, event: { ...editable, latitude: 30.1234567 } },
        schemas.AdminEventEditorDetailDto!,
        schemas
      )
    ).toBe(false)
    const source = {
      id,
      name: "Calendar",
      url: "https://example.com/events",
      source_type: "website",
      extraction_mode: "deterministic",
      processing_mode: "manual_review",
      city_id: null,
      is_active: true,
      auto_approve: false,
      scrape_interval_hours: 24,
      last_scraped_at: timestamp,
      last_status: "stale",
      error_count: 3,
      notes: null,
      date_window_days: null,
      consecutive_zero_result_scrapes: 3,
      stale_escalated_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    }
    expect(matchesContract(source, schemas.AdminSourceDto!, schemas)).toBe(true)
    expect(
      matchesContract({ ...source, last_status: "invalid" }, schemas.AdminSourceDto!, schemas)
    ).toBe(false)
  })

  it("validates closed request bodies and the documented Nest errors against OpenAPI", () => {
    const document = buildOpenApiDocument(app)
    const schemas = document.components!.schemas! as Record<string, ContractSchema>
    const id = "22222222-2222-4222-8222-222222222222"
    const examples = [
      ["/v1/admin/events/{id}/status", "put", { status: "draft", reason: null }],
      ["/v1/admin/events/bulk-status", "post", { event_ids: [id], status: "published" }],
      ["/v1/admin/events/bulk-delete", "post", { event_ids: [id] }],
      [
        "/v1/admin/events/{id}",
        "put",
        {
          patch: {
            description: null,
            latitude: 30.1234567,
            recurrence_info: null,
          },
          tag_ids: [],
          lock_edited_fields: false,
          decision_reason: null,
        },
      ],
      [
        "/v1/admin/sources",
        "post",
        {
          name: "Calendar",
          url: "https://example.com/events",
          source_type: "website",
          extraction_mode: "deterministic",
          processing_mode: "manual_review",
        },
      ],
      ["/v1/admin/sources/{id}", "put", { notes: null }],
      ["/v1/admin/sources/{id}/processing-mode", "put", { mode: "llm_review" }],
      ["/v1/admin/sources/bulk-processing-mode", "post", { mode: "auto_approve" }],
      [
        "/v1/admin/users/{id}/access",
        "put",
        { is_enabled: false, disabled_reason: "policy violation" },
      ],
      [
        "/v1/admin/invite-codes",
        "post",
        { max_uses: 1, expires_at: null, notes: "Family referral" },
      ],
    ] as const
    for (const [path, method, body] of examples) {
      const requestBody = document.paths[path]![method]!.requestBody!
      if (!("content" in requestBody)) throw new Error("expected inline body schema")
      const schema = requestBody.content["application/json"]!.schema!
      expect(matchesContract(body, schema, schemas)).toBe(true)
      expect(matchesContract({ ...body, actor_id: id }, schema, schemas)).toBe(false)
      expect(matchesContract({}, schema, schemas)).toBe(false)
    }
    const rejectRequestBody =
      document.paths["/v1/admin/invite-requests/{id}/reject"]!.post!.requestBody!
    if (!("content" in rejectRequestBody)) throw new Error("expected inline reject body schema")
    const rejectSchema = rejectRequestBody.content["application/json"]!.schema!
    expect(matchesContract({}, rejectSchema, schemas)).toBe(true)
    expect(matchesContract({ actor_id: id }, rejectSchema, schemas)).toBe(false)
    for (const error of [
      { statusCode: 401, message: "missing bearer token", error: "Unauthorized" },
      { statusCode: 403, message: "user is not provisioned", error: "Forbidden" },
      { statusCode: 403, message: "admin access is not provisioned", error: "Forbidden" },
      { statusCode: 404, message: "Not Found" },
    ]) {
      expect(matchesContract(error, schemas.AdminErrorDto!, schemas)).toBe(true)
    }
    expect(
      matchesContract(
        {
          statusCode: 400,
          message: "invalid request body",
          error: "Bad Request",
          issues: [{ path: "status", message: "invalid status" }],
        },
        schemas.AdminValidationErrorDto!,
        schemas
      )
    ).toBe(true)
    expect(
      matchesContract(
        { statusCode: 400, message: "invalid request body", error: "Bad Request" },
        schemas.AdminValidationErrorDto!,
        schemas
      )
    ).toBe(false)
  })

  it("fails closed for unsupported contract constraints and schema types", () => {
    const schemas: Record<string, ContractSchema> = {}
    expect(matchesContract("a", { type: "string", minLength: 1 }, schemas)).toBe(true)
    expect(matchesContract("", { type: "string", minLength: 1 }, schemas)).toBe(false)
    expect(matchesContract({ value: true }, { type: "object", minProperties: 1 }, schemas)).toBe(
      true
    )
    expect(matchesContract({}, { type: "object", minProperties: 1 }, schemas)).toBe(false)
    expect(() =>
      matchesContract("value", { type: "string", pattern: "^value$" } as ContractSchema, schemas)
    ).toThrow("unsupported contract keyword: pattern")
    expect(() => matchesContract("value", { type: "mystery" }, schemas)).toThrow(
      "unsupported contract type: mystery"
    )
    expect(() => matchesContract("value", {}, schemas)).toThrow("contract schema requires a type")
  })

  it("keeps the generated OpenAPI artifact in sync with the application", () => {
    const committed = JSON.parse(readFileSync("openapi.json", "utf8"))
    expect(JSON.parse(JSON.stringify(buildOpenApiDocument(app)))).toEqual(committed)
  })
})
