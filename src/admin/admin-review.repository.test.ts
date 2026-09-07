import { describe, expect, it, vi } from "vitest"
import type { PoolClient } from "pg"

import type { DbService } from "../db/db.service.js"
import type { AdminEventsInput } from "./admin-review.input.js"
import { AdminReviewRepository } from "./admin-review.repository.js"

const actor = "11111111-1111-4111-8111-111111111111"
const input: AdminEventsInput = {
  status: "draft",
  cityId: "city",
  cityIsNull: false,
  keyword: "literal %_\\ '); DROP TABLE events; --",
  afterCreatedAt: "2026-09-01 12:00:00.123456+00",
  afterId: "after-id",
  limit: 201,
  llmReviewStatus: "succeeded",
  llmReviewDecision: "approve",
  llmReviewed: true,
  sourceId: "source",
}

function setup(rows: unknown[] = []) {
  const query = vi.fn().mockResolvedValue({ rows })
  const withTransaction = vi.fn(async (work: (client: PoolClient) => Promise<unknown>) =>
    work({ query } as unknown as PoolClient)
  )
  const repository = new AdminReviewRepository({ withTransaction } as unknown as DbService)
  return { query, withTransaction, repository }
}

describe("AdminReviewRepository", () => {
  it("binds all list filters and preserves timestamp and numeric strings", async () => {
    const rows = [{ created_at: input.afterCreatedAt, ai_confidence: "0.1234567890123456789" }]
    const { repository, query } = setup(rows)
    expect(await repository.listEvents(actor, input)).toBe(rows)
    const [sql, params] = query.mock.calls[1]!
    expect(sql).toContain("public.admin_events_enriched(")
    expect(sql).toContain("p_source_id => $11::uuid")
    expect(sql).not.toContain(input.keyword)
    expect(params).toEqual([
      "draft",
      "city",
      false,
      input.keyword,
      input.afterCreatedAt,
      "after-id",
      201,
      "succeeded",
      "approve",
      true,
      "source",
    ])
  })

  it.each(["list", "facets", "status", "bulk-status", "delete"])(
    "%s begins every transaction with locally scoped actor claims",
    async (operation) => {
      const { repository, query, withTransaction } = setup([{ affected: 3 }])
      if (operation === "list") await repository.listEvents(actor, input)
      if (operation === "facets") await repository.facets(actor, "%_")
      if (operation === "status") await repository.setStatus(actor, "id", "draft", "reason")
      if (operation === "bulk-status") await repository.bulkStatus(actor, ["id"], "archived")
      if (operation === "delete") await repository.bulkDelete(actor, ["id"])
      expect(withTransaction).toHaveBeenCalledTimes(1)
      expect(query).toHaveBeenCalledTimes(
        operation === "bulk-status" || operation === "delete" ? 3 : 2
      )
      expect(query.mock.calls[0]).toEqual([
        "SELECT set_config('request.jwt.claims', $1, true)",
        [JSON.stringify({ sub: actor, role: "authenticated" })],
      ])
    }
  )

  it("uses only parameterized public mutation RPCs and returns their affected counts", async () => {
    const { repository, query } = setup([{ affected: 2 }])
    expect(await repository.setStatus(actor, "event", "rejected", "why ' ")).toBe(1)
    expect(query.mock.calls[1]).toEqual([
      "SELECT public.admin_update_event_status($1::uuid, $2::text, $3::text)",
      ["event", "rejected", "why ' "],
    ])
    expect(await repository.bulkStatus(actor, ["one", "two"], "published")).toBe(2)
    expect(query.mock.calls[4]).toEqual([
      "SELECT public.admin_batch_set_event_status($1::uuid[], $2::text) AS affected",
      [["one", "two"], "published"],
    ])
    expect(await repository.bulkDelete(actor, ["one", "two"])).toBe(2)
    expect(query.mock.calls[7]).toEqual([
      "SELECT public.admin_delete_events($1::uuid[]) AS affected",
      [["one", "two"]],
    ])
  })

  it("passes nullable facet keyword as a bound RPC argument", async () => {
    const { repository, query } = setup()
    await repository.facets(actor, null)
    expect(query.mock.calls[1]).toEqual([
      "SELECT city_id, source_id, status, count FROM public.admin_event_facets($1::text)",
      [null],
    ])
  })

  it("propagates RPC failure through withTransaction for rollback", async () => {
    const { repository, query } = setup()
    const error = Object.assign(new Error("forbidden"), { code: "42501" })
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(error)
    await expect(repository.bulkDelete(actor, ["id"])).rejects.toBe(error)
  })

  it("never invokes an RPC when installing actor claims fails", async () => {
    const { repository, query } = setup()
    const error = new Error("claims failed")
    query.mockRejectedValueOnce(error)
    await expect(repository.bulkDelete(actor, ["id"])).rejects.toBe(error)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it.each(["status", "delete"])(
    "locks bulk %s targets in UUID order before reading snapshots",
    async (operation) => {
      const { repository, query } = setup([{ affected: 2 }])
      const ids = ["second", "first", "second"]
      if (operation === "status") await repository.bulkStatus(actor, ids, "published")
      else await repository.bulkDelete(actor, ids)
      expect(query.mock.calls[1]).toEqual([
        "SELECT id FROM public.events WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE",
        [ids],
      ])
      expect(query.mock.calls[2]![0]).toContain(
        operation === "status"
          ? "public.admin_batch_set_event_status"
          : "public.admin_delete_events"
      )
    }
  )

  it.each(["status", "delete"])("does not run bulk %s when locking fails", async (operation) => {
    const { repository, query } = setup()
    const error = new Error("lock failed")
    query.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(error)
    const result =
      operation === "status"
        ? repository.bulkStatus(actor, ["id"], "published")
        : repository.bulkDelete(actor, ["id"])
    await expect(result).rejects.toBe(error)
    expect(query).toHaveBeenCalledTimes(2)
  })
})
