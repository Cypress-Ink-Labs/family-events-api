import { describe, expect, it, vi } from "vitest"

import { AdminCorrectionReportRepository } from "./admin-correction-report.repository.js"

describe("AdminCorrectionReportRepository correction attribution", () => {
  it("derives the event from the locked report and delegates linkage to the guarded RPC", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ allowed: true }] })
      .mockResolvedValueOnce({ rows: [{ event_id: "event-1" }] })
      .mockResolvedValueOnce({
        rows: [{ id: "correction-1", event_id: "event-1", audit_log_id: "audit-1" }],
      })
    const db = {
      withTransaction: (work: (client: { query: typeof query }) => unknown) => work({ query }),
    }
    const repository = new AdminCorrectionReportRepository(db as never)

    const result = await repository.linkCorrection(
      "operator-1",
      "report-1",
      "audit-1",
      "Fixed date"
    )

    expect(result?.id).toBe("correction-1")
    expect(query.mock.calls[2]).toEqual([expect.stringContaining("FOR UPDATE"), ["report-1"]])
    expect(query.mock.calls[3]).toEqual([
      expect.stringContaining("private.link_listing_correction"),
      ["report-1", "event-1", "operator-1", "audit-1", "Fixed date"],
    ])
  })

  it("does not permit a caller-supplied event when linking a correction", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ allowed: true }] })
      .mockResolvedValueOnce({ rows: [] })
    const db = {
      withTransaction: (work: (client: { query: typeof query }) => unknown) => work({ query }),
    }
    const repository = new AdminCorrectionReportRepository(db as never)

    await expect(
      repository.linkCorrection("operator-1", "missing-report", "fabricated-audit", "note")
    ).resolves.toBeNull()
    expect(query).toHaveBeenCalledTimes(3)
  })
})
