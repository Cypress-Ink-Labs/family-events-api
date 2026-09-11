import { describe, expect, it, vi } from "vitest"

import { AdminDeadLetterRepository, type DeadLetterRow } from "./admin-dead-letter.repository.js"

const actor = "10000000-0000-4000-8000-000000000001"
const dead = (overrides: Partial<DeadLetterRow> = {}): DeadLetterRow => ({
  id: "9007199254740993",
  attempt_count: 4,
  enqueued_at: "2026-06-01 00:00:00.123456+00",
  started_at: null,
  finished_at: "2026-06-02 00:00:00.123456+00",
  next_attempt_at: "2026-06-01 00:00:00.123456+00",
  last_error: "failed",
  trigger_type: "retry",
  source_id: "20000000-0000-4000-8000-000000000002",
  source_run_id: "30000000-0000-4000-8000-000000000003",
  event_id: null,
  ...overrides,
})

function repository(responses: unknown[]) {
  const query = vi.fn()
  for (const response of responses) query.mockResolvedValueOnce(response)
  const db = {
    withTransaction: (work: (client: { query: typeof query }) => Promise<unknown>) =>
      work({ query }),
  }
  return { repository: new AdminDeadLetterRepository(db as never), query }
}

describe("AdminDeadLetterRepository", () => {
  it.each([
    ["source", "source_scrape_queue", "source_id, source_run_id", null],
    ["tag", "event_tag_queue", "source_run_id, event_id", "2026-06-02 00:00:00+00"],
  ] as const)(
    "lists %s rows with bigint keyset binding",
    async (queue, table, columns, finishedAt) => {
      const { repository: subject, query } = repository([
        { rows: [] },
        { rows: [{ allowed: true }] },
        { rows: [dead()] },
      ])
      await subject.list(actor, {
        queue,
        limit: 25,
        cursor: { finishedAt, id: "9007199254740993" },
      })
      expect(query.mock.calls[0]).toEqual([
        "SELECT set_config('request.jwt.claims', $1, true)",
        [JSON.stringify({ sub: actor, role: "authenticated" })],
      ])
      expect(query.mock.calls[1]?.[0]).toContain("private.is_admin")
      const [sql, bindings] = query.mock.calls[2]!
      expect(sql).toContain(`FROM public.${table}`)
      expect(sql).toContain(columns)
      expect(sql).toContain("$2::bigint")
      expect(sql).toContain(
        finishedAt === null
          ? "finished_at IS NULL AND id < $2::bigint"
          : "finished_at < $1::timestamptz OR finished_at IS NULL"
      )
      expect(bindings).toEqual([finishedAt, "9007199254740993", 26])
    }
  )

  it.each([
    ["source", "admin_retry_source_scrape_queue", false],
    ["tag", "admin_retry_dead_tag_queue", true],
  ] as const)(
    "retries %s by queue id and resolves its disposition",
    async (queue, rpc, removes) => {
      const row = dead(
        queue === "tag" ? { source_id: null, event_id: "40000000-0000-4000-8000-000000000004" } : {}
      )
      const { repository: subject, query } = repository([
        { rows: [] },
        { rows: [{ allowed: true }] },
        { rows: [row] },
        { rows: [] },
        { rows: [{ ok: true }] },
        { rows: [{ id: "9007199254740994", status: "pending" }] },
        { rows: [] },
      ])
      expect(await subject.retry(actor, queue, row.id)).toEqual({
        disposition: "queued",
        resultingQueueId: "9007199254740994",
      })
      expect(query.mock.calls[2]).toEqual([
        expect.stringContaining("id = $1::bigint"),
        ["9007199254740993"],
      ])
      expect(query.mock.calls[4]).toEqual([expect.stringContaining(rpc), [row.id]])
      expect(query.mock.calls[6]?.[0]).toContain("INSERT INTO public.admin_audit_log")
      const metadata = JSON.parse(query.mock.calls[6]?.[1][2])
      expect(metadata).toMatchObject({
        queue,
        original_id: row.id,
        source_run_id: row.source_run_id,
        resulting_queue_id: "9007199254740994",
      })
      // The source production RPC retains the dead source row; the tag RPC removes its dead row.
      expect(removes).toBe(queue === "tag")
    }
  )

  it("reports already_active and does not perform the result lookup twice", async () => {
    const { repository: subject, query } = repository([
      { rows: [] },
      { rows: [{ allowed: true }] },
      { rows: [dead()] },
      { rows: [{ id: "9007199254740994", status: "processing" }] },
      { rows: [{ ok: true }] },
      { rows: [] },
    ])
    expect(await subject.retry(actor, "source", dead().id)).toMatchObject({
      disposition: "already_active",
    })
    expect(query).toHaveBeenCalledTimes(6)
  })

  it("deletes only a locked dead row and audits the mapped actor transaction", async () => {
    const { repository: subject, query } = repository([
      { rows: [] },
      { rows: [{ allowed: true }] },
      { rows: [dead()] },
      { rows: [{ ok: true }] },
      { rows: [] },
    ])
    await expect(subject.remove(actor, "source", dead().id)).resolves.toBe(true)
    expect(query.mock.calls[3]).toEqual([
      "SELECT public.admin_delete_dead_source_queue($1::bigint) AS ok",
      [dead().id],
    ])
    expect(query.mock.calls[4]?.[1]).toEqual([
      "dead_letter.delete",
      "source_scrape_queue",
      expect.stringContaining('"original_id":"9007199254740993"'),
    ])
  })

  it("stops after authorization denial", async () => {
    const { repository: subject, query } = repository([
      { rows: [] },
      { rows: [{ allowed: false }] },
    ])
    await expect(subject.list(actor, { queue: "tag", limit: 10, cursor: null })).rejects.toThrow(
      "database admin access denied"
    )
    expect(query).toHaveBeenCalledTimes(2)
  })
})
