import { BadRequestException } from "@nestjs/common"
import { describe, expect, it } from "vitest"

import { CRON_LABELS, parseCronRunId, parseCronRunsQuery } from "./admin-cron.input.js"

describe("admin cron input", () => {
  it("defaults and bounds history limits", () => {
    expect(parseCronRunsQuery({})).toEqual({ label: undefined, limit: 50 })
    expect(parseCronRunsQuery({ label: CRON_LABELS[0], limit: "200" })).toEqual({
      label: CRON_LABELS[0],
      limit: 200,
    })
    for (const limit of ["0", "201", "1.5"]) {
      expect(() => parseCronRunsQuery({ limit })).toThrow(BadRequestException)
    }
  })

  it("rejects arbitrary labels and parameters", () => {
    expect(() => parseCronRunsQuery({ label: "anything" })).toThrow(BadRequestException)
    expect(() => parseCronRunsQuery({ queue: "scrape" })).toThrow(BadRequestException)
  })

  it("keeps PostgreSQL bigint ids as canonical strings", () => {
    expect(parseCronRunId("9223372036854775807")).toBe("9223372036854775807")
    for (const id of ["01", "0", "9223372036854775808", "1.0"]) {
      expect(() => parseCronRunId(id)).toThrow(BadRequestException)
    }
  })
})
