import { BadRequestException } from "@nestjs/common"
import { describe, expect, it } from "vitest"

import {
  parseAdminDeleteUserBody,
  parseAdminSetUserAccessBody,
  parseAdminUserId,
  parseAdminUsersQuery,
} from "./admin-user.input.js"

const ID = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"

describe("admin user input", () => {
  it("normalizes IDs and access reasons", () => {
    expect(parseAdminUserId(ID)).toBe(ID.toLowerCase())
    expect(
      parseAdminSetUserAccessBody({ is_enabled: false, disabled_reason: "  policy violation  " })
    ).toEqual({ isEnabled: false, disabledReason: "policy violation" })
    expect(parseAdminSetUserAccessBody({ is_enabled: true, disabled_reason: "ignored" })).toEqual({
      isEnabled: true,
      disabledReason: null,
    })
  })

  it.each([
    {},
    { is_enabled: "true" },
    { is_enabled: false, disabled_reason: "x".repeat(1001) },
    { is_enabled: true, actor_id: ID },
  ])("rejects invalid access body %j", (body) => {
    expect(() => parseAdminSetUserAccessBody(body)).toThrow(BadRequestException)
  })

  it("rejects forged query/delete fields and invalid IDs", () => {
    expect(() => parseAdminUsersQuery({ actor_id: ID })).toThrow(BadRequestException)
    expect(() => parseAdminDeleteUserBody({ actor_id: ID })).toThrow(BadRequestException)
    expect(() => parseAdminUserId("bad")).toThrow(BadRequestException)
    expect(parseAdminUsersQuery({})).toBeUndefined()
    expect(parseAdminDeleteUserBody(undefined)).toBeUndefined()
  })
})
