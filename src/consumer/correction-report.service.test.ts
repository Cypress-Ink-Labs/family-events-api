import { ConflictException } from "@nestjs/common"
import { describe, expect, it, vi } from "vitest"

import { capabilityHash, type CorrectionReportInput } from "./correction-report.input.js"
import { CorrectionReportService } from "./correction-report.service.js"

const EVENT_ID = "4dc17888-65c6-4a78-ab4a-3270bcad8438"
const INPUT: CorrectionReportInput = {
  category: "wrong_date_time",
  details: "Starts at noon",
  contact: { email: "parent@example.com" },
  evidence_urls: ["https://example.com/proof"],
}

function serviceWith(
  query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>
) {
  const client = { query: vi.fn(query) }
  const db = { withTransaction: (work: (value: typeof client) => unknown) => work(client) }
  return { service: new CorrectionReportService(db as never), query: client.query }
}

describe("CorrectionReportService", () => {
  it("enforces the anonymous capability issuance budget before storing a hash", async () => {
    const { service, query } = serviceWith(async (sql) => {
      if (sql.includes("count(*)")) return { rows: [{ count: 120 }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    await expect(service.mintAnonymousCapability("secret")).rejects.toMatchObject({ status: 429 })
    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO"),
      expect.anything()
    )
  })

  it("stores only a purpose-bound hash when issuance is below budget", async () => {
    const { service, query } = serviceWith(async (sql) =>
      sql.includes("count(*)") ? { rows: [{ count: 119 }], rowCount: 1 } : { rows: [], rowCount: 0 }
    )
    await service.mintAnonymousCapability("secret")
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO private.correction_report_capabilities"),
      [capabilityHash("secret")]
    )
  })

  it("atomically consumes the presented capability, rotates it, and stores PII privately", async () => {
    const { service, query } = serviceWith(async (sql) => {
      if (sql.includes("FROM public.events")) return { rows: [{}], rowCount: 1 }
      if (sql.includes("UPDATE private.correction_report_capabilities"))
        return { rows: [{}], rowCount: 1 }
      if (sql.includes("count(*)")) return { rows: [{ count: 19 }], rowCount: 1 }
      if (sql.includes("recent_content") && sql.includes("RETURNING"))
        return { rows: [{}], rowCount: 1 }
      if (sql.includes("INSERT INTO public.correction_reports"))
        return {
          rows: [{ id: "report-1", status: "new", priority: 1, created_at: "now" }],
          rowCount: 1,
        }
      return { rows: [], rowCount: 0 }
    })
    await service.submit(EVENT_ID, INPUT, null, "old", "new")
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE private.correction_report_capabilities"),
      [capabilityHash("old")]
    )
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO private.correction_report_capabilities"),
      [capabilityHash("new")]
    )
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO private.correction_report_private"),
      ["report-1", JSON.stringify(INPUT.contact), INPUT.evidence_urls]
    )
  })

  it("rejects an exhausted anonymous per-event rate and an expired capability", async () => {
    const make = (capabilityRows: number, recentCount: number) =>
      serviceWith(async (sql) => {
        if (sql.includes("FROM public.events")) return { rows: [{}], rowCount: 1 }
        if (sql.includes("UPDATE private.correction_report_capabilities"))
          return { rows: capabilityRows ? [{}] : [], rowCount: capabilityRows }
        if (sql.includes("count(*)")) return { rows: [{ count: recentCount }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      }).service
    await expect(make(1, 20).submit(EVENT_ID, INPUT, null, "old", "new")).rejects.toMatchObject({
      status: 429,
    })
    await expect(make(0, 0).submit(EVENT_ID, INPUT, null, "old", "new")).rejects.toMatchObject({
      status: 429,
    })
  })

  it("applies the signed-in advisory rate and confirmed restrictions", async () => {
    const make = (restricted: boolean, recentCount: number) =>
      serviceWith(async (sql) => {
        if (sql.includes("FROM public.events")) return { rows: [{}], rowCount: 1 }
        if (sql.includes("reporter_restrictions"))
          return { rows: restricted ? [{}] : [], rowCount: restricted ? 1 : 0 }
        if (sql.includes("count(*)")) return { rows: [{ count: recentCount }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      }).service
    await expect(
      make(true, 0).submit(EVENT_ID, INPUT, "user-1", undefined, "unused")
    ).rejects.toMatchObject({ status: 429 })
    await expect(
      make(false, 5).submit(EVENT_ID, INPUT, "user-1", undefined, "unused")
    ).rejects.toMatchObject({ status: 429 })
  })

  it("replaces an expired digest and rejects a live duplicate", async () => {
    const make = (digestRows: number) =>
      serviceWith(async (sql) => {
        if (sql.includes("FROM public.events")) return { rows: [{}], rowCount: 1 }
        if (sql.includes("reporter_restrictions")) return { rows: [], rowCount: 0 }
        if (sql.includes("count(*)")) return { rows: [{ count: 0 }], rowCount: 1 }
        if (sql.includes("recent_content") && sql.includes("RETURNING"))
          return { rows: digestRows ? [{}] : [], rowCount: digestRows }
        if (sql.includes("INSERT INTO public.correction_reports"))
          return {
            rows: [{ id: "report-1", status: "new", priority: 1, created_at: "now" }],
            rowCount: 1,
          }
        return { rows: [], rowCount: 0 }
      })
    const accepted = make(1)
    await expect(
      accepted.service.submit(EVENT_ID, INPUT, "user-1", undefined, "unused")
    ).resolves.toMatchObject({ id: "report-1" })
    expect(accepted.query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE private.correction_report_recent_content.expires_at <= now()"),
      expect.anything()
    )
    await expect(
      make(0).service.submit(EVENT_ID, INPUT, "user-1", undefined, "unused")
    ).rejects.toBeInstanceOf(ConflictException)
  })

  it("does not accept a report for an unavailable event", async () => {
    const { service, query } = serviceWith(async () => ({ rows: [], rowCount: 0 }))
    await expect(
      service.submit(EVENT_ID, INPUT, "user-1", undefined, "unused")
    ).rejects.toBeInstanceOf(ConflictException)
    expect(query).toHaveBeenCalledTimes(1)
  })
})
