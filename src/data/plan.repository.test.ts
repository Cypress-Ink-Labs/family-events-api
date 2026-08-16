import { describe, expect, it, vi } from "vitest"

import type { DbService } from "../db/db.service.js"
import { PlanRepository } from "./plan.repository.js"

function makeDb() {
  const query = vi.fn<(text: string, params?: unknown[]) => Promise<unknown[]>>(async () => [])
  return { db: { query } as unknown as DbService, query }
}

describe("PlanRepository.planForRange", () => {
  it("calls plan_events_for_user_range with named parameters and the app's defaults", async () => {
    const { db, query } = makeDb()
    await new PlanRepository(db).planForRange({
      userKey: "u-1",
      dateFrom: "from",
      dateTo: "to",
    })
    const [sql, params] = query.mock.calls[0]!
    expect(sql).toContain("public.plan_events_for_user_range(")
    expect(sql).toContain("p_weather_fit => $8::text")
    expect(sql).not.toContain("SELECT *")
    expect(params).toEqual(["u-1", "from", "to", null, null, null, null, "neutral", 5])
  })

  it("binds each input to its RPC parameter position", async () => {
    const { db, query } = makeDb()
    await new PlanRepository(db).planForRange({
      userKey: "user",
      dateFrom: "from",
      dateTo: "to",
      cityIds: ["c1", "c2"],
      lat: 30.1,
      lng: -92.2,
      kidAge: 7,
      weatherFit: "outdoor",
      limit: 3,
    })
    expect(query.mock.calls[0]?.[1]).toEqual([
      "user",
      "from",
      "to",
      ["c1", "c2"],
      30.1,
      -92.2,
      7,
      "outdoor",
      3,
    ])
  })
})
