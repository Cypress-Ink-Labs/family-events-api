import "reflect-metadata"

import { BadRequestException } from "@nestjs/common"
import { GUARDS_METADATA } from "@nestjs/common/constants.js"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { ClerkAuthGuard } from "../auth/clerk.guard.js"
import { MappedIdentityGuard } from "../auth/mapped-identity.guard.js"
import { OperatorGuard } from "../auth/operator.guard.js"
import { AdminSourceController } from "./admin-source.controller.js"
import type { AdminSourceService } from "./admin-source.service.js"

const ACTOR = "11111111-1111-4111-8111-111111111111"
const SOURCE = "22222222-2222-4222-8222-222222222222"
const request = {
  identity: {
    supabaseUuid: ACTOR,
    clerkUserId: "user_operator",
    role: "operator" as const,
    email: "operator@example.test",
  },
}
const source = { id: SOURCE }
const createBody = {
  name: "Calendar",
  url: "https://example.com/events",
  source_type: "website",
  extraction_mode: "deterministic_then_llm",
  processing_mode: "llm_review",
}

describe("AdminSourceController", () => {
  const service = {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    scrape: vi.fn(),
    setProcessingMode: vi.fn(),
    bulkSetProcessingMode: vi.fn(),
  }
  const controller = new AdminSourceController(service as unknown as AdminSourceService)

  beforeEach(() => {
    vi.resetAllMocks()
    service.list.mockResolvedValue([source])
    service.create.mockResolvedValue(source)
    service.update.mockResolvedValue(source)
    service.scrape.mockResolvedValue({ queueId: "9007199254740993", deduped: true })
    service.setProcessingMode.mockResolvedValue(source)
    service.bulkSetProcessingMode.mockResolvedValue(undefined)
  })

  it("uses the exact authentication, identity, operator guard order", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminSourceController)).toEqual([
      ClerkAuthGuard,
      MappedIdentityGuard,
      OperatorGuard,
    ])
  })

  it("lists and creates sources with only the mapped actor", async () => {
    await expect(controller.list({}, request)).resolves.toEqual([source])
    await expect(controller.create(createBody, request)).resolves.toBe(source)
    expect(service.list).toHaveBeenCalledWith(ACTOR)
    expect(service.create).toHaveBeenCalledWith(ACTOR, {
      name: "Calendar",
      url: "https://example.com/events",
      sourceType: "website",
      extractionMode: "deterministic_then_llm",
      processingMode: "llm_review",
      cityId: null,
      isActive: true,
      scrapeIntervalHours: 24,
      notes: null,
      dateWindowDays: null,
    })
  })

  it("updates a source while preserving null and omitted fields", async () => {
    await expect(
      controller.update(SOURCE, { notes: null, is_active: false }, request)
    ).resolves.toBe(source)
    expect(service.update).toHaveBeenCalledWith(ACTOR, SOURCE, {
      notes: null,
      isActive: false,
    })
  })

  it("projects durable queue bigint and deduplication results", async () => {
    await expect(controller.scrape(SOURCE, undefined, request)).resolves.toEqual({
      queue_id: "9007199254740993",
      deduped: true,
    })
    expect(service.scrape).toHaveBeenCalledWith(ACTOR, SOURCE)
  })

  it("sets single and bulk processing modes", async () => {
    await expect(
      controller.setProcessingMode(SOURCE, { mode: "auto_approve" }, request)
    ).resolves.toBe(source)
    await expect(
      controller.bulkSetProcessingMode({ mode: "manual_review" }, request)
    ).resolves.toEqual({ ok: true })
    expect(service.setProcessingMode).toHaveBeenCalledWith(ACTOR, SOURCE, "auto_approve")
    expect(service.bulkSetProcessingMode).toHaveBeenCalledWith(ACTOR, "manual_review")
  })

  it.each([
    ["list", "", { actor_id: ACTOR }],
    ["create", "", { ...createBody, actor_id: ACTOR }],
    ["update", "bad-id", { notes: null }],
    ["update", SOURCE, { processing_mode: "auto_approve" }],
    ["scrape", SOURCE, { actor_id: ACTOR }],
    ["mode", SOURCE, { mode: "invalid" }],
    ["bulk", "", { mode: "manual_review", actor_id: ACTOR }],
  ] as const)("rejects invalid %s input before service access", async (operation, id, body) => {
    const result = (async (): Promise<unknown> =>
      operation === "list"
        ? controller.list(body, request)
        : operation === "create"
          ? controller.create(body, request)
          : operation === "update"
            ? controller.update(id, body, request)
            : operation === "scrape"
              ? controller.scrape(id, body, request)
              : operation === "mode"
                ? controller.setProcessingMode(id, body, request)
                : controller.bulkSetProcessingMode(body, request))()
    await expect(result).rejects.toBeInstanceOf(BadRequestException)
    for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled()
  })
})
