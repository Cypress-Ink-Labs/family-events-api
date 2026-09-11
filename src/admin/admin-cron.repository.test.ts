import { describe, expect, it, vi } from "vitest"

import { CRON_LABELS } from "./admin-cron.input.js"
import { AdminCronRepository } from "./admin-cron.repository.js"

describe("AdminCronRepository", () => {
  it("sets claims, authorizes, and uses fixed allowlists before every read", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ allowed: true }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ allowed: true }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ allowed: true }] })
      .mockResolvedValueOnce({ rows: [] })
    const db = {
      withTransaction: (work: (client: { query: typeof query }) => Promise<unknown>) =>
        work({ query }),
    }
    const repository = new AdminCronRepository(db as never)
    const actor = "10000000-0000-4000-8000-000000000001"
    await repository.gatesAndLatest(actor, CRON_LABELS)
    await repository.runs(actor, CRON_LABELS, undefined, 50)
    await repository.detail(actor, "9223372036854775807")

    expect(
      query.mock.calls.filter(([sql]) => String(sql).includes("private.is_admin"))
    ).toHaveLength(3)
    expect(query.mock.calls[2]?.[1]).toEqual([CRON_LABELS])
    expect(query.mock.calls[5]?.[1]).toEqual([CRON_LABELS, null, 50])
    expect(query.mock.calls[8]?.[1]).toEqual(["9223372036854775807", CRON_LABELS])
    expect(query.mock.calls[8]?.[0]).toContain("e.run_key = r.run_key")
    expect(query.mock.calls[8]?.[0]).toContain("'provider', e.provider")
    expect(query.mock.calls[8]?.[0]).toContain("'sequence', e.sequence")
  })
})
