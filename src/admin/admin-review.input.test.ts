import { BadRequestException } from "@nestjs/common"
import { describe, expect, it } from "vitest"

import {
  ADMIN_STATUSES,
  LLM_REVIEW_DECISIONS,
  LLM_REVIEW_STATUSES,
  parseAdminBulkDeleteBody,
  parseAdminBulkStatusBody,
  parseAdminEventId,
  parseAdminEventsQuery,
  parseAdminFacetsQuery,
  parseAdminStatusBody,
} from "./admin-review.input.js"

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const OTHER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

describe("admin query parsing", () => {
  it("uses nullable filters and a default limit of 200", () => {
    expect(parseAdminEventsQuery({})).toEqual({
      status: null,
      cityId: null,
      cityIsNull: null,
      keyword: null,
      afterCreatedAt: null,
      afterId: null,
      limit: 200,
      llmReviewStatus: null,
      llmReviewDecision: null,
      llmReviewed: null,
      sourceId: null,
    })
  })

  it.each([1, 200, 500])("accepts limit %i", (limit) => {
    expect(parseAdminEventsQuery({ limit: String(limit) }).limit).toBe(limit)
  })

  it.each([
    "0",
    "501",
    "-1",
    "1.5",
    "1e2",
    "Infinity",
    "",
    " 1",
    "9007199254740992",
    1,
    null,
    ["1"],
  ])("rejects invalid limit %j", (limit) => {
    expect(() => parseAdminEventsQuery({ limit })).toThrow(BadRequestException)
  })

  it.each(ADMIN_STATUSES)("accepts status %s everywhere", (status) => {
    expect(parseAdminEventsQuery({ status }).status).toBe(status)
    expect(parseAdminStatusBody({ status }).status).toBe(status)
    expect(parseAdminBulkStatusBody({ event_ids: [ID], status }).status).toBe(status)
  })

  it.each(LLM_REVIEW_STATUSES)("accepts review status %s", (llm_review_status) => {
    expect(parseAdminEventsQuery({ llm_review_status }).llmReviewStatus).toBe(llm_review_status)
  })

  it.each(LLM_REVIEW_DECISIONS)("accepts review decision %s", (llm_review_decision) => {
    expect(parseAdminEventsQuery({ llm_review_decision }).llmReviewDecision).toBe(
      llm_review_decision
    )
  })

  it.each(["status", "llm_review_status", "llm_review_decision"])(
    "rejects invalid %s boundaries",
    (field) => {
      for (const value of ["all", "", "PUBLISHED", "unknown", null, 1, true, ["draft"]]) {
        expect(() => parseAdminEventsQuery({ [field]: value })).toThrow(BadRequestException)
      }
    }
  )

  it.each(["city_is_null", "llm_reviewed"])("parses strict %s booleans", (field) => {
    const property = field === "city_is_null" ? "cityIsNull" : "llmReviewed"
    expect(parseAdminEventsQuery({ [field]: "true" })[property]).toBe(true)
    expect(parseAdminEventsQuery({ [field]: "false" })[property]).toBe(false)
    for (const value of [true, false, "TRUE", "1", "0", "", null, ["true"]]) {
      expect(() => parseAdminEventsQuery({ [field]: value })).toThrow(BadRequestException)
    }
  })

  it("accepts and projects UUID filters", () => {
    expect(parseAdminEventsQuery({ city_id: ID, source_id: OTHER_ID })).toMatchObject({
      cityId: ID,
      sourceId: OTHER_ID,
    })
    expect(parseAdminEventId(ID.toUpperCase())).toBe(ID)
  })

  it.each(["city_id", "source_id", "after_id"])("rejects malformed %s", (field) => {
    for (const value of ["", "not-a-uuid", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", null, 1, [ID]]) {
      expect(() => parseAdminEventsQuery({ [field]: value })).toThrow(BadRequestException)
    }
  })

  it("rejects unknown query keys and nonobjects", () => {
    for (const query of [
      { actor: ID },
      { afterCreatedAt: "2026-01-01T00:00:00Z" },
      { q: "family" },
      [],
      null,
    ]) {
      expect(() => parseAdminEventsQuery(query)).toThrow(BadRequestException)
    }
    expect(() => parseAdminFacetsQuery({ status: "draft" })).toThrow(BadRequestException)
  })

  it("rejects keyword overflow without truncating and trims allowed keywords", () => {
    for (const parse of [parseAdminEventsQuery, parseAdminFacetsQuery]) {
      expect(parse({ keyword: "x".repeat(100) }).keyword).toHaveLength(100)
      expect(parse({ keyword: "  family  " }).keyword).toBe("family")
      expect(parse({ keyword: " " }).keyword).toBeNull()
      expect(() => parse({ keyword: "x".repeat(101) })).toThrow(BadRequestException)
      expect(() => parse({ keyword: " ".repeat(101) })).toThrow(BadRequestException)
      expect(() => parse({ keyword: ["family"] })).toThrow(BadRequestException)
    }
  })

  it.each([
    "2026-09-07T12:34:56.123456Z",
    "2026-09-07T12:34:56.123456+05:30",
    "2026-09-07 12:34:56.123456+00",
    "2026-09-07 12:34:56.1-0500",
    "2024-02-29T00:00:00Z",
  ])("preserves timestamp %s without Date conversion", (after_created_at) => {
    expect(parseAdminEventsQuery({ after_created_at, after_id: ID })).toMatchObject({
      afterCreatedAt: after_created_at,
      afterId: ID,
    })
  })

  it.each([
    "2026-09-07T12:34:56",
    "2026-09-07T12:34:56.1234567Z",
    "2026-02-29T12:34:56Z",
    "2026-04-31T12:34:56Z",
    "2026-00-07T12:34:56Z",
    "2026-13-07T12:34:56Z",
    "2026-09-00T12:34:56Z",
    "2026-09-07T24:34:56Z",
    "2026-09-07T12:60:56Z",
    "2026-09-07T12:34:60Z",
    "2026-09-07T12:34:56+24:00",
    "2026-09-07T12:34:56+00:60",
    "0000-01-01T00:00:00Z",
    "not-a-timestamp",
    "",
  ])("rejects malformed timestamp %s", (after_created_at) => {
    expect(() => parseAdminEventsQuery({ after_created_at, after_id: ID })).toThrow(
      BadRequestException
    )
  })

  it("requires both cursor components", () => {
    expect(() => parseAdminEventsQuery({ after_id: ID })).toThrow(BadRequestException)
    expect(() => parseAdminEventsQuery({ after_created_at: "2026-01-01T00:00:00Z" })).toThrow(
      BadRequestException
    )
  })
})

describe("admin mutation parsing", () => {
  it("trims reason, accepts 1000 characters, and normalizes missing, null, or blank", () => {
    for (const reason of [undefined, null, "", "   "]) {
      expect(parseAdminStatusBody({ status: "draft", reason })).toEqual({
        status: "draft",
        reason: null,
      })
    }
    expect(parseAdminStatusBody({ status: "draft", reason: "  reviewed  " }).reason).toBe(
      "reviewed"
    )
    expect(parseAdminStatusBody({ status: "draft", reason: "x".repeat(1000) }).reason).toHaveLength(
      1000
    )
    for (const reason of ["x".repeat(1001), 3, true, [], {}]) {
      expect(() => parseAdminStatusBody({ status: "draft", reason })).toThrow(BadRequestException)
    }
  })

  it("rejects invalid or missing mutation statuses", () => {
    for (const status of [undefined, null, "", "all", "PUBLISHED", 1]) {
      expect(() => parseAdminStatusBody({ status })).toThrow(BadRequestException)
      expect(() => parseAdminBulkStatusBody({ status, event_ids: [ID] })).toThrow(
        BadRequestException
      )
    }
  })

  it("validates submitted count before deduplicating including UUID case variants", () => {
    for (const parse of [
      parseAdminBulkDeleteBody,
      (body: unknown) => parseAdminBulkStatusBody({ ...(body as object), status: "draft" }),
    ]) {
      expect(parse({ event_ids: [ID, ID, ID.toUpperCase(), OTHER_ID] }).eventIds).toEqual([
        ID,
        OTHER_ID,
      ])
      expect(parse({ event_ids: Array.from({ length: 500 }, () => ID) }).eventIds).toEqual([ID])
      for (const event_ids of [
        [],
        Array.from({ length: 501 }, () => ID),
        [ID, "invalid"],
        ID,
        null,
        undefined,
      ]) {
        expect(() => parse({ event_ids })).toThrow(BadRequestException)
      }
    }
  })

  it("rejects unknown body keys, including actor IDs", () => {
    expect(() => parseAdminStatusBody({ status: "draft", actor_id: ID })).toThrow(
      BadRequestException
    )
    expect(() =>
      parseAdminBulkStatusBody({ event_ids: [ID], status: "draft", reason: "no" })
    ).toThrow(BadRequestException)
    expect(() => parseAdminBulkDeleteBody({ event_ids: [ID], actor_id: ID })).toThrow(
      BadRequestException
    )
    expect(() => parseAdminEventId("invalid")).toThrow(BadRequestException)
  })

  it("returns the existing stable Nest validation envelope", () => {
    try {
      parseAdminStatusBody({ status: "draft", actor_id: ID })
      expect.unreachable()
    } catch (error) {
      expect((error as BadRequestException).getResponse()).toMatchObject({
        statusCode: 400,
        message: "invalid request body",
        error: "Bad Request",
        issues: [{ path: "", message: expect.any(String) }],
      })
    }
  })
})
