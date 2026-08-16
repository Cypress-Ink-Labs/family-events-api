import { describe, expect, it, vi } from "vitest"

import type { DbService } from "../db/db.service.js"
import { CronGateService } from "./cron-gate.service.js"
import type { FailurePingService } from "./failure-ping.service.js"
import { FAMILIES } from "./families.js"

const SCHEDULE = FAMILIES.scrape.schedules[0]!

function makeService(
  queryResults: { enabled: boolean }[],
  failurePing?: Pick<FailurePingService, "send">
) {
  const query = vi.fn(async (text: string, _params?: unknown[]) => {
    if (text.startsWith("SELECT")) return queryResults
    return []
  })
  const service = new CronGateService(
    { query } as unknown as DbService,
    failurePing as FailurePingService | undefined
  )
  return { service, query }
}

describe("CronGateService", () => {
  it("treats a missing kill-switch row as enabled (legacy COALESCE semantics)", async () => {
    const { service } = makeService([])
    expect(await service.isEnabled("cron-scrape-sources")).toBe(true)
  })

  it("skips the tick without recording a run when disabled", async () => {
    const { service, query } = makeService([{ enabled: false }])
    const fn = vi.fn()
    await service.runGated(SCHEDULE, fn)
    expect(fn).not.toHaveBeenCalled()
    expect(query.mock.calls.filter(([text]) => text.startsWith("INSERT"))).toHaveLength(0)
  })

  it("records a succeeded run with the handler summary as body", async () => {
    const { service, query } = makeService([{ enabled: true }])
    await service.runGated(SCHEDULE, async () => "imported 5 events")
    const insert = query.mock.calls.find(([text]) => text.startsWith("INSERT"))
    expect(insert?.[1]).toEqual([
      SCHEDULE.replaces,
      "succeeded",
      expect.any(Number),
      "imported 5 events",
    ])
  })

  it("records a failed run and rethrows so pg-boss retry policy applies", async () => {
    const { service, query } = makeService([{ enabled: true }])
    await expect(
      service.runGated(SCHEDULE, async () => {
        throw new Error("scrape blew up")
      })
    ).rejects.toThrow("scrape blew up")
    const insert = query.mock.calls.find(([text]) => text.startsWith("INSERT"))
    expect(insert?.[1]).toEqual([SCHEDULE.replaces, "failed", expect.any(Number), "scrape blew up"])
  })

  it("pings the operator with the legacy label after recording a failed run", async () => {
    const send = vi.fn(async () => "sent" as const)
    const { service, query } = makeService([{ enabled: true }], { send })
    await expect(
      service.runGated(SCHEDULE, async () => {
        throw new Error("scrape blew up")
      })
    ).rejects.toThrow("scrape blew up")
    const insertIndex = query.mock.calls.findIndex(([text]) => text.startsWith("INSERT"))
    expect(insertIndex).toBeGreaterThanOrEqual(0)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({
      functionName: SCHEDULE.replaces,
      kind: "function_failed",
      error: "scrape blew up",
    })
  })

  it("does not ping on a succeeded run", async () => {
    const send = vi.fn(async () => "sent" as const)
    const { service } = makeService([{ enabled: true }], { send })
    await service.runGated(SCHEDULE, async () => "imported 5 events")
    expect(send).not.toHaveBeenCalled()
  })

  it("rethrows the original error when the ping rejects", async () => {
    const send = vi.fn(async () => {
      throw new Error("telegram down")
    })
    const { service, query } = makeService([{ enabled: true }], { send })
    await expect(
      service.runGated(SCHEDULE, async () => {
        throw new Error("scrape blew up")
      })
    ).rejects.toThrow("scrape blew up")
    expect(send).toHaveBeenCalledTimes(1)
    const insert = query.mock.calls.find(([text]) => text.startsWith("INSERT"))
    expect(insert?.[1]).toEqual([SCHEDULE.replaces, "failed", expect.any(Number), "scrape blew up"])
  })
})
