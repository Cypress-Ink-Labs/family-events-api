import "reflect-metadata"

import { BadRequestException } from "@nestjs/common"
import { GUARDS_METADATA } from "@nestjs/common/constants.js"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { ClerkAuthGuard } from "../auth/clerk.guard.js"
import { MappedIdentityGuard } from "../auth/mapped-identity.guard.js"
import { OperatorGuard } from "../auth/operator.guard.js"
import { AdminReviewController } from "./admin-review.controller.js"
import type { AdminReviewService } from "./admin-review.service.js"

const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const CREATED_AT = "2026-09-07 12:34:56.123456+00"
const request = {
  identity: {
    supabaseUuid: ACTOR,
    clerkUserId: "user_operator",
    role: "operator" as const,
    email: "operator@example.test",
  },
}

describe("AdminReviewController", () => {
  const service = {
    listEvents: vi.fn(),
    facets: vi.fn(),
    setStatus: vi.fn(),
    bulkStatus: vi.fn(),
    bulkDelete: vi.fn(),
  }
  const controller = new AdminReviewController(service as unknown as AdminReviewService)

  beforeEach(() => vi.resetAllMocks())

  it("uses the exact authentication, identity, operator guard order", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminReviewController)).toEqual([
      ClerkAuthGuard,
      MappedIdentityGuard,
      OperatorGuard,
    ])
  })

  it("projects only review fields and preserves numeric strings and microseconds", async () => {
    const event = {
      id: ID,
      title: "Review",
      status: "draft",
      start_datetime: CREATED_AT,
      venue_name: null,
      city_id: null,
      source_id: ID,
      source_name: null,
      is_free: true,
      age_min: null,
      age_max: 12,
      ai_confidence: "0.1234567890123456789",
      llm_review_status: "pending",
      llm_review_decision: null,
      llm_review_reason: null,
      llm_review_error: null,
      created_at: CREATED_AT,
    }
    service.listEvents.mockResolvedValue({
      events: [{ ...event, total_count: "3", description: "private", admin_last_edited_by: ACTOR }],
      totalCount: 3,
      nextCursor: { afterCreatedAt: CREATED_AT, afterId: ID },
    })
    expect(await controller.listEvents({ limit: "1" }, request)).toEqual({
      events: [event],
      total_count: 3,
      next_cursor: { after_created_at: CREATED_AT, after_id: ID },
    })
    expect(service.listEvents).toHaveBeenCalledWith(ACTOR, expect.objectContaining({ limit: 1 }))
  })

  it("projects null cursor and facets", async () => {
    service.listEvents.mockResolvedValue({ events: [], totalCount: 0, nextCursor: null })
    service.facets.mockResolvedValue([
      { city_id: null, source_id: ID, status: "draft", count: 2, secret: true },
    ])
    expect(await controller.listEvents({}, request)).toEqual({
      events: [],
      total_count: 0,
      next_cursor: null,
    })
    expect(await controller.facets({ keyword: " family " }, request)).toEqual([
      { city_id: null, source_id: ID, status: "draft", count: 2 },
    ])
    expect(service.facets).toHaveBeenCalledWith(ACTOR, "family")
  })

  it("takes actor UUID exclusively from mapped request identity for all mutations", async () => {
    service.setStatus.mockResolvedValue(1)
    service.bulkStatus.mockResolvedValue(0)
    service.bulkDelete.mockResolvedValue(1)
    expect(
      await controller.setStatus(ID, { status: "published", reason: " yes " }, request)
    ).toEqual({ ok: true, affected: 1 })
    expect(
      await controller.bulkStatus({ event_ids: [ID, ID], status: "archived" }, request)
    ).toEqual({ ok: true, affected: 0 })
    expect(await controller.bulkDelete({ event_ids: [ID] }, request)).toEqual({
      ok: true,
      affected: 1,
    })
    expect(service.setStatus).toHaveBeenCalledWith(ACTOR, ID, "published", "yes")
    expect(service.bulkStatus).toHaveBeenCalledWith(ACTOR, [ID], "archived")
    expect(service.bulkDelete).toHaveBeenCalledWith(ACTOR, [ID])
  })

  it("rejects forged actor input and invalid values before reaching the service", async () => {
    await expect(controller.listEvents({ actor_id: ID }, request)).rejects.toBeInstanceOf(
      BadRequestException
    )
    await expect(controller.facets({ city_id: ID }, request)).rejects.toBeInstanceOf(
      BadRequestException
    )
    await expect(controller.setStatus("bad", { status: "draft" }, request)).rejects.toBeInstanceOf(
      BadRequestException
    )
    await expect(
      controller.setStatus(ID, { status: "draft", actor_id: ID }, request)
    ).rejects.toBeInstanceOf(BadRequestException)
    await expect(
      controller.bulkStatus({ event_ids: [ID], status: "draft", actor_id: ID }, request)
    ).rejects.toBeInstanceOf(BadRequestException)
    await expect(controller.bulkDelete({ event_ids: [] }, request)).rejects.toBeInstanceOf(
      BadRequestException
    )
    for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled()
  })
})
