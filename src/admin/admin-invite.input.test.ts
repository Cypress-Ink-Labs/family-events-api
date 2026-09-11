import { BadRequestException } from "@nestjs/common"
import { describe, expect, it } from "vitest"

import {
  parseAdminCreateInviteCodeBody,
  parseAdminInviteCodeId,
  parseAdminInviteRequestQuery,
  parseAdminRejectInviteRequestBody,
} from "./admin-invite.input.js"

describe("admin invite input", () => {
  it("normalizes fields while preserving omission", () => {
    expect(parseAdminCreateInviteCodeBody({ max_uses: 1, notes: "  " })).toEqual({
      maxUses: 1,
      notes: null,
    })
    expect(parseAdminCreateInviteCodeBody({ max_uses: 2 })).toEqual({ maxUses: 2 })
  })
  it.each([
    { max_uses: 0 },
    { max_uses: 10001 },
    { max_uses: 1.5 },
    { max_uses: 1, expires_at: "2026-01-01T00:00:00" },
    { max_uses: 1, extra: true },
  ])("rejects invalid body %#", (body) => {
    expect(() => parseAdminCreateInviteCodeBody(body)).toThrow(BadRequestException)
  })
  it("lowercases ids", () => {
    expect(parseAdminInviteCodeId("A0EBC190-9C0B-4F30-9AC1-E50CA986E91B")).toBe(
      "a0ebc190-9c0b-4f30-9ac1-e50ca986e91b"
    )
  })
  it("defaults and validates the request status filter", () => {
    expect(parseAdminInviteRequestQuery({})).toBe("pending")
    expect(parseAdminInviteRequestQuery({ status: "all" })).toBe("all")
    expect(() => parseAdminInviteRequestQuery({ status: "unknown" })).toThrow(BadRequestException)
    expect(() => parseAdminInviteRequestQuery({ status: "pending", extra: true })).toThrow(
      BadRequestException
    )
  })
  it("normalizes optional rejection notes", () => {
    expect(parseAdminRejectInviteRequestBody({})).toEqual({})
    expect(parseAdminRejectInviteRequestBody({ notes: null })).toEqual({ notes: null })
    expect(parseAdminRejectInviteRequestBody({ notes: "  " })).toEqual({ notes: null })
    expect(parseAdminRejectInviteRequestBody({ notes: "  reason  " })).toEqual({ notes: "reason" })
    expect(() => parseAdminRejectInviteRequestBody({ notes: "x".repeat(1001) })).toThrow(
      BadRequestException
    )
  })
})
