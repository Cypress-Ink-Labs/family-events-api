import { describe, expect, it, vi } from "vitest"

import { AdminStatisticsRepository } from "./admin-statistics.repository.js"

describe("AdminStatisticsRepository", () => {
  it("sets transaction-local claims and checks database admin before both RPCs", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ allowed: true }] })
      .mockResolvedValueOnce({ rows: [{ stats: { total_events: 0 } }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ allowed: true }] })
      .mockResolvedValueOnce({ rows: [{ stats: { window_days: 30 } }] })
    const db = {
      withTransaction: (work: (client: { query: typeof query }) => Promise<unknown>) =>
        work({ query }),
    }
    const repository = new AdminStatisticsRepository(db as never)
    await repository.dashboard("10000000-0000-4000-8000-000000000001")
    await repository.pipeline("10000000-0000-4000-8000-000000000001", 30)
    expect(
      query.mock.calls.filter(([sql]) => String(sql).includes("private.is_admin"))
    ).toHaveLength(2)
    expect(query.mock.calls[2]?.[0]).toContain("admin_dashboard_stats")
    expect(query.mock.calls[5]).toEqual([
      "SELECT public.pipeline_learning_stats($1::int) AS stats",
      [30],
    ])
  })
})
