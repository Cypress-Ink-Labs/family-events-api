import { describe, expect, it, vi } from "vitest"

import type { DbService } from "../db/db.service.js"
import { CronGateService } from "./cron-gate.service.js"
import { FAMILIES } from "./families.js"

const SCHEDULE = FAMILIES.scrape.schedules[0]!

function makeService(queryResults: { enabled: boolean }[]) {
  const query = vi.fn(async (text: string, _params?: unknown[]) => {
    if (text.startsWith("SELECT")) return queryResults
    return []
  })
  const service = new CronGateService({ query } as unknown as DbService)
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
})
