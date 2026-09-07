import { ForbiddenException, NotFoundException } from "@nestjs/common"
import { describe, expect, it, vi } from "vitest"

import type { AdminEventsInput } from "./admin-review.input.js"
import {
  AdminAccessDeniedError,
  AdminReviewRepository,
  type AdminEventRow,
} from "./admin-review.repository.js"
import { AdminReviewService, safeAdminCount } from "./admin-review.service.js"

const input: AdminEventsInput = {
  status: "draft",
  cityId: null,
  cityIsNull: true,
  keyword: "storytime",
  afterCreatedAt: null,
  afterId: null,
  limit: 200,
  llmReviewStatus: "succeeded",
  llmReviewDecision: null,
  llmReviewed: true,
  sourceId: "source",
}

function row(id: number): AdminEventRow {
  return {
    id: String(id),
    title: "Event",
    status: "draft",
    start_datetime: "2026-10-01 12:00:00+00",
    venue_name: null,
    city_id: null,
    source_id: "source",
    source_name: null,
    is_free: true,
    age_min: null,
    age_max: null,
    ai_confidence: "0.1234567890123456789",
    llm_review_status: "succeeded",
    llm_review_decision: null,
    llm_review_reason: null,
    llm_review_error: null,
    created_at: "2026-09-01 12:00:00.123456+00",
    total_count: "601",
  }
}

function setup() {
  const repository = {
    listEvents: vi.fn().mockResolvedValue([]),
    facets: vi.fn().mockResolvedValue([]),
    setStatus: vi.fn().mockResolvedValue(1),
    bulkStatus: vi.fn().mockResolvedValue(3),
    bulkDelete: vi.fn().mockResolvedValue(2),
  }
  return {
    repository,
    service: new AdminReviewService(repository as unknown as AdminReviewRepository),
  }
}

describe("AdminReviewService", () => {
  it.each([1, 200, 499])("uses limit+1 lookahead for limit %i", async (limit) => {
    const { repository, service } = setup()
    const rows = Array.from({ length: limit + 1 }, (_, i) => row(i))
    repository.listEvents.mockResolvedValueOnce(rows)
    const page = await service.listEvents("actor", { ...input, limit })
    expect(repository.listEvents).toHaveBeenCalledExactlyOnceWith("actor", {
      ...input,
      limit: limit + 1,
    })
    expect(page.events).toEqual(rows.slice(0, limit))
    expect(page.nextCursor).toEqual({
      afterCreatedAt: rows[limit - 1]!.created_at,
      afterId: String(limit - 1),
    })
    expect(page.totalCount).toBe(601)
  })

  it.each([1, 200, 500])(
    "does not advertise another page for exactly %i final rows",
    async (limit) => {
      const { repository, service } = setup()
      repository.listEvents.mockResolvedValueOnce(Array.from({ length: limit }, (_, i) => row(i)))
      const page = await service.listEvents("actor", { ...input, limit })
      expect(page.nextCursor).toBeNull()
      expect(repository.listEvents).toHaveBeenCalledTimes(limit === 500 ? 2 : 1)
    }
  )

  it("probes after the final row at limit 500 without losing microseconds or filters", async () => {
    const { repository, service } = setup()
    repository.listEvents
      .mockResolvedValueOnce(Array.from({ length: 500 }, (_, i) => row(i)))
      .mockResolvedValueOnce([row(500)])
    const page = await service.listEvents("actor", { ...input, limit: 500 })
    expect(repository.listEvents.mock.calls).toEqual([
      ["actor", { ...input, limit: 500 }],
      ["actor", { ...input, limit: 1, afterCreatedAt: row(499).created_at, afterId: "499" }],
    ])
    expect(page.nextCursor).toEqual({ afterCreatedAt: row(499).created_at, afterId: "499" })
  })

  it("obtains a real total for an empty cursor page through the same filters without a cursor", async () => {
    const { repository, service } = setup()
    repository.listEvents.mockResolvedValueOnce([]).mockResolvedValueOnce([row(0)])
    const page = await service.listEvents("actor", {
      ...input,
      afterCreatedAt: row(0).created_at,
      afterId: "old",
    })
    expect(repository.listEvents.mock.calls[1]).toEqual(["actor", { ...input, limit: 1 }])
    expect(page).toEqual({ events: [], totalCount: 601, nextCursor: null })
  })

  it("returns zero when the count probe also has no matching rows", async () => {
    const { service } = setup()
    expect(await service.listEvents("actor", input)).toEqual({
      events: [],
      totalCount: 0,
      nextCursor: null,
    })
  })

  it("converts facet bigint counts safely", async () => {
    const { repository, service } = setup()
    const facet = { city_id: null, source_id: "source", status: "draft", count: "42" }
    repository.facets.mockResolvedValueOnce([facet])
    expect(await service.facets("actor", "%")).toEqual([{ ...facet, count: 42 }])
    expect(repository.facets).toHaveBeenCalledWith("actor", "%")
    repository.facets.mockResolvedValueOnce([{ ...facet, count: "9007199254740992" }])
    await expect(service.facets("actor", null)).rejects.toThrow("unsafe admin count")
  })

  it("does not lose precision in list totals", async () => {
    const { repository, service } = setup()
    repository.listEvents.mockResolvedValueOnce([{ ...row(0), total_count: "9007199254740992" }])
    await expect(service.listEvents("actor", input)).rejects.toThrow("unsafe admin count")
  })

  it("forwards only the supplied trusted actor and returns affected integers", async () => {
    const { repository, service } = setup()
    expect(await service.setStatus("actor", "event", "rejected", "reason")).toBe(1)
    expect(repository.setStatus).toHaveBeenCalledWith("actor", "event", "rejected", "reason")
    expect(await service.bulkStatus("actor", ["a", "b"], "published")).toBe(3)
    expect(repository.bulkStatus).toHaveBeenCalledWith("actor", ["a", "b"], "published")
    expect(await service.bulkDelete("actor", ["a", "b"])).toBe(2)
    expect(repository.bulkDelete).toHaveBeenCalledWith("actor", ["a", "b"])
  })

  it.each([
    new AdminAccessDeniedError(),
    { code: "42501", message: "forbidden" },
    { code: "P0001", message: "ADMIN_EVENT_ADMIN_REQUIRED" },
    { code: "P0001", message: "forbidden" },
  ])(
    "returns a provisioning error for verified database admin denial on every operation: %j",
    async (error) => {
      const { repository, service } = setup()
      for (const mock of Object.values(repository)) mock.mockRejectedValue(error)
      for (const operation of [
        () => service.listEvents("actor", input),
        () => service.facets("actor", null),
        () => service.setStatus("actor", "event", "draft", null),
        () => service.bulkStatus("actor", ["event"], "draft"),
        () => service.bulkDelete("actor", ["event"]),
      ]) {
        await expect(operation()).rejects.toBeInstanceOf(ForbiddenException)
        await expect(operation()).rejects.toMatchObject({
          response: {
            statusCode: 403,
            error: "Forbidden",
            message: "admin access is not provisioned",
          },
        })
      }
    }
  )

  it("maps P0002 only for single status updates", async () => {
    const { repository, service } = setup()
    const error = { code: "P0002", message: "event not found" }
    repository.setStatus.mockRejectedValueOnce(error)
    repository.bulkDelete.mockRejectedValueOnce(error)
    await expect(service.setStatus("actor", "event", "draft", null)).rejects.toBeInstanceOf(
      NotFoundException
    )
    await expect(service.bulkDelete("actor", ["event"])).rejects.toBe(error)
  })

  it.each([
    { code: "23503" },
    { code: "22023" },
    { code: "P0001", message: "other ADMIN_EVENT_ADMIN_REQUIRED error" },
    new Error("connection failed"),
  ])("preserves unrelated database errors: %j", async (error) => {
    const { repository, service } = setup()
    repository.setStatus.mockRejectedValueOnce(error)
    await expect(service.setStatus("actor", "event", "draft", null)).rejects.toBe(error)
  })
})

describe("safeAdminCount", () => {
  it.each([0, "0", 42, "42", "9007199254740991"])("accepts safe integer %s", (value) => {
    expect(safeAdminCount(value)).toBe(Number(value))
  })
  it.each(["9007199254740992", 9007199254740992, "", "1e3", "1.5", "-1", -1, NaN, Infinity])(
    "rejects invalid or unsafe count %s",
    (value) => expect(() => safeAdminCount(value)).toThrow()
  )
})
