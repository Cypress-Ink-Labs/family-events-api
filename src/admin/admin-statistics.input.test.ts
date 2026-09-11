import { BadRequestException } from "@nestjs/common"
import { describe, expect, it } from "vitest"

import { parseAdminDashboardQuery, parseAdminPipelineQuery } from "./admin-statistics.input.js"

describe("admin statistics query parsing", () => {
  it("accepts only an empty dashboard query", () => {
    expect(parseAdminDashboardQuery({})).toBeUndefined()
    expect(() => parseAdminDashboardQuery({ extra: "1" })).toThrow(BadRequestException)
  })

  it("defaults and bounds the integer pipeline window", () => {
    expect(parseAdminPipelineQuery({})).toBe(30)
    expect(parseAdminPipelineQuery({ window_days: "365" })).toBe(365)
    for (const window_days of ["0", "366", "1.5", "03", ["30"]]) {
      expect(() => parseAdminPipelineQuery({ window_days })).toThrow(BadRequestException)
    }
    expect(() => parseAdminPipelineQuery({ extra: "1" })).toThrow(BadRequestException)
  })
})
