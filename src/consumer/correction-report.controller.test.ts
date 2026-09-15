import { GUARDS_METADATA } from "@nestjs/common/constants.js"
import { describe, expect, it, vi } from "vitest"

import { OptionalClerkAuthGuard } from "../auth/optional-clerk.guard.js"
import {
  CorrectionReportCapabilityController,
  CorrectionReportController,
} from "./correction-report.controller.js"

const BODY = { category: "other", details: "The address is wrong", contact: { email: "a@b.co" } }

describe("correction report HTTP contract", () => {
  it("uses optional authentication and forwards an anonymous capability cookie", async () => {
    const reports = {
      submit: vi.fn().mockResolvedValue({
        id: "report-1",
        status: "new",
        priority: 2,
        created_at: "now",
      }),
    }
    const response = { cookie: vi.fn() }
    const controller = new CorrectionReportController(reports as never)
    const result = await controller.submit(
      "event-1",
      BODY,
      { headers: { cookie: "other=x; correction_report_capability=presented%2Btoken" } } as never,
      response as never
    )
    expect(result).toEqual({ id: "report-1", status: "new", priority: 2, created_at: "now" })
    expect(result).not.toHaveProperty("contact")
    expect(reports.submit).toHaveBeenCalledWith(
      "event-1",
      BODY,
      null,
      "presented+token",
      expect.any(String)
    )
    expect(response.cookie).toHaveBeenCalledWith(
      "correction_report_capability",
      expect.any(String),
      expect.objectContaining({ httpOnly: true, path: "/v1/events" })
    )
    expect(
      Reflect.getMetadata(GUARDS_METADATA, CorrectionReportController.prototype.submit)
    ).toContain(OptionalClerkAuthGuard)
  })

  it("uses identity when present and does not echo private fields", async () => {
    const reports = {
      submit: vi.fn().mockResolvedValue({
        id: "report-1",
        status: "new",
        priority: 2,
        created_at: "now",
      }),
    }
    const response = { cookie: vi.fn() }
    const result = await new CorrectionReportController(reports as never).submit(
      "event-1",
      BODY,
      {
        headers: { cookie: "correction_report_capability=ignored" },
        identity: { supabaseUuid: "user-1" },
      } as never,
      response as never
    )
    expect(reports.submit).toHaveBeenCalledWith(
      "event-1",
      BODY,
      "user-1",
      "ignored",
      expect.any(String)
    )
    expect(response.cookie).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain("a@b.co")
  })

  it("mints the capability before setting a private cookie", async () => {
    const reports = { mintAnonymousCapability: vi.fn().mockResolvedValue(undefined) }
    const response = { cookie: vi.fn() }
    await new CorrectionReportCapabilityController(reports as never).mint(response as never)
    expect(reports.mintAnonymousCapability).toHaveBeenCalledWith(expect.any(String))
    expect(response.cookie).toHaveBeenCalledWith(
      "correction_report_capability",
      expect.any(String),
      expect.objectContaining({ httpOnly: true, sameSite: "lax", maxAge: 900_000 })
    )
  })
})
