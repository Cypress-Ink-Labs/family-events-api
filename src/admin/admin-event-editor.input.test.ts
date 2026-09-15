import { BadRequestException } from "@nestjs/common"
import { describe, expect, it } from "vitest"

import {
  ADMIN_EDITABLE_EVENT_FIELDS,
  parseAdminUnlockEventBody,
  parseAdminUpdateEventBody,
} from "./admin-event-editor.input.js"

const EVENT = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"
const TAG = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB"

describe("parseAdminUpdateEventBody", () => {
  it("maps every wire patch field to camelCase without dropping explicit nulls", () => {
    const input = parseAdminUpdateEventBody({
      patch: {
        title: "  Story time  ",
        description: null,
        start_datetime: "2026-09-08T10:00:00.123456Z",
        end_datetime: null,
        timezone: "  America/Chicago  ",
        venue_name: null,
        address: null,
        city_id: null,
        latitude: null,
        longitude: null,
        age_min: null,
        age_max: null,
        price: null,
        is_free: true,
        admission_cost_state: "free",
        admission_amount: null,
        admission_cost_evidence: "Source says free admission",
        parking_details: "Free parking is available.",
        reservation_details: null,
        is_outdoor: null,
        source_url: null,
        source_name: null,
        source_id: null,
        images: ["https://example.com/image.jpg"],
        status: "published",
        recurrence_info: null,
        is_featured: false,
      },
      tag_ids: [TAG, TAG.toLowerCase()],
      lock_edited_fields: false,
      decision_reason: "  corrected schedule  ",
    })
    expect(Object.keys(input.patch)).toHaveLength(ADMIN_EDITABLE_EVENT_FIELDS.length)
    expect(input).toEqual({
      patch: {
        title: "Story time",
        description: null,
        startDatetime: "2026-09-08T10:00:00.123456Z",
        endDatetime: null,
        timezone: "America/Chicago",
        venueName: null,
        address: null,
        cityId: null,
        latitude: null,
        longitude: null,
        ageMin: null,
        ageMax: null,
        price: null,
        isFree: true,
        admissionCostState: "free",
        admissionAmount: null,
        admissionCostEvidence: "Source says free admission",
        parkingDetails: "Free parking is available.",
        reservationDetails: null,
        isOutdoor: null,
        sourceUrl: null,
        sourceName: null,
        sourceId: null,
        images: ["https://example.com/image.jpg"],
        status: "published",
        recurrenceInfo: null,
        isFeatured: false,
      },
      tagIds: [TAG.toLowerCase()],
      lockEditedFields: false,
      decisionReason: "corrected schedule",
    })
  })

  it("preserves omitted patch fields and defaults controls", () => {
    expect(
      parseAdminUpdateEventBody({
        patch: { description: null },
        tag_ids: [],
      })
    ).toEqual({
      patch: { description: null },
      tagIds: [],
      lockEditedFields: true,
      decisionReason: null,
    })
    expect(parseAdminUpdateEventBody({ patch: {}, tag_ids: [] }).patch).toEqual({})
  })

  it.each([
    [{ patch: {}, tag_ids: [], actor_id: EVENT }, "actor_id"],
    [{ patch: { id: EVENT }, tag_ids: [] }, "patch"],
    [{ patch: {}, tag_ids: [], lock_edited_fields: "true" }, "lock_edited_fields"],
    [{ patch: {}, tag_ids: [EVENT, "bad"] }, "tag_ids"],
    [{ patch: {}, tag_ids: Array(501).fill(EVENT) }, "tag_ids"],
    [{ patch: { title: " " }, tag_ids: [] }, "patch.title"],
    [{ patch: { description: "x".repeat(10_001) }, tag_ids: [] }, "patch.description"],
    [{ patch: { start_datetime: "2026-09-08" }, tag_ids: [] }, "patch.start_datetime"],
    [
      {
        patch: {
          start_datetime: "2026-09-08T10:00:00Z",
          end_datetime: "2026-09-08T09:00:00Z",
        },
        tag_ids: [],
      },
      "patch.end_datetime",
    ],
    [{ patch: { latitude: 91 }, tag_ids: [] }, "patch.latitude"],
    [{ patch: { longitude: -181 }, tag_ids: [] }, "patch.longitude"],
    [{ patch: { age_min: -1 }, tag_ids: [] }, "patch.age_min"],
    [{ patch: { age_min: 12, age_max: 2 }, tag_ids: [] }, "patch.age_max"],
    [{ patch: { price: -0.01 }, tag_ids: [] }, "patch.price"],
    [{ patch: { source_url: "javascript:alert(1)" }, tag_ids: [] }, "patch.source_url"],
    [{ patch: { images: ["ftp://example.com/image.jpg"] }, tag_ids: [] }, "patch.images"],
    [{ patch: { images: Array(21).fill("https://example.com/a") }, tag_ids: [] }, "patch.images"],
    [{ patch: { status: "pending" }, tag_ids: [] }, "patch.status"],
    [{ patch: {}, tag_ids: [], decision_reason: "x".repeat(1001) }, "decision_reason"],
  ])("rejects invalid or unbounded input at %s", (body, path) => {
    try {
      parseAdminUpdateEventBody(body)
      throw new Error("expected parser failure")
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException)
      expect((error as BadRequestException).getResponse()).toMatchObject({
        statusCode: 400,
        message: "invalid request body",
        error: "Bad Request",
        issues: expect.arrayContaining([
          expect.objectContaining({ path: expect.stringMatching(`^${path.replace(".", "\\.")}`) }),
        ]),
      })
    }
  })
})

describe("parseAdminUnlockEventBody", () => {
  it.each([undefined, {}])("accepts an absent or empty body", (body) => {
    expect(parseAdminUnlockEventBody(body)).toBeUndefined()
  })

  it("rejects body properties", () => {
    expect(() => parseAdminUnlockEventBody({ actor_id: EVENT })).toThrow(BadRequestException)
  })
})
