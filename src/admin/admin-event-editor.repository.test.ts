import type { PoolClient } from "pg"
import { describe, expect, it, vi } from "vitest"

import type { DbService } from "../db/db.service.js"
import { AdminAccessDeniedError } from "./admin-database.js"
import {
  AdminEventEditorRepository,
  toDatabaseEventPatch,
} from "./admin-event-editor.repository.js"

const ACTOR = "11111111-1111-4111-8111-111111111111"
const EVENT = "22222222-2222-4222-8222-222222222222"
const TAG = "33333333-3333-4333-8333-333333333333"

function setup() {
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql === "SELECT private.is_admin() AS allowed") return { rows: [{ allowed: true }] }
    if (sql.includes("FROM public.events")) return { rows: [{ id: EVENT }] }
    if (sql.includes("FROM public.event_tags")) return { rows: [{ id: TAG }] }
    if (sql.includes("FROM public.tags")) return { rows: [{ id: TAG }] }
    return { rows: [] }
  })
  const withTransaction = vi.fn(async (work: (client: PoolClient) => Promise<unknown>) =>
    work({ query } as unknown as PoolClient)
  )
  return {
    query,
    withTransaction,
    repository: new AdminEventEditorRepository({ withTransaction } as unknown as DbService),
  }
}

describe("AdminEventEditorRepository", () => {
  it("maps camelCase patch keys while preserving omitted and explicit null fields", () => {
    expect(
      toDatabaseEventPatch({
        title: "Event",
        description: null,
        startDatetime: "2026-09-08T10:00:00Z",
        isFree: false,
        recurrenceInfo: null,
      })
    ).toEqual({
      title: "Event",
      description: null,
      start_datetime: "2026-09-08T10:00:00Z",
      is_free: false,
      recurrence_info: null,
    })
  })

  it("requires database authorization before direct editor reads", async () => {
    const { repository, query } = setup()
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ allowed: false }] })
    await expect(repository.get(ACTOR, EVENT)).rejects.toBeInstanceOf(AdminAccessDeniedError)
    expect(query).toHaveBeenCalledTimes(2)
  })

  it("reads the event, assigned tags, and bounded available choices in one actor transaction", async () => {
    const { repository, query, withTransaction } = setup()
    await expect(repository.get(ACTOR, EVENT)).resolves.toEqual({
      event: { id: EVENT },
      tags: [{ id: TAG }],
      availableTags: [{ id: TAG }],
    })
    expect(withTransaction).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0]).toEqual([
      "SELECT set_config('request.jwt.claims', $1, true)",
      [JSON.stringify({ sub: ACTOR, role: "authenticated" })],
    ])
    expect(query.mock.calls[1]).toEqual(["SELECT private.is_admin() AS allowed"])
    expect(query.mock.calls[2]![1]).toEqual([EVENT])
    expect(query.mock.calls[3]![0]).toContain("FROM public.event_tags")
    expect(query.mock.calls[4]![0]).toContain("FROM public.tags")
  })

  it("returns null without querying tags when the event is missing", async () => {
    const { repository, query } = setup()
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ allowed: true }] })
      .mockResolvedValueOnce({ rows: [] })
    await expect(repository.get(ACTOR, EVENT)).resolves.toBeNull()
    expect(query).toHaveBeenCalledTimes(3)
  })

  it("binds all five latest RPC arguments and returns the committed editor shape", async () => {
    const { repository, query } = setup()
    const input = {
      patch: { description: null, isFeatured: true },
      tagIds: [TAG],
      lockEditedFields: false,
      decisionReason: "reason ' with SQL",
    }
    await repository.update(ACTOR, EVENT, input)
    expect(query.mock.calls[1]).toEqual([
      expect.stringContaining("public.admin_update_event"),
      [
        EVENT,
        JSON.stringify({ description: null, is_featured: true }),
        [TAG],
        false,
        input.decisionReason,
      ],
    ])
    expect(query.mock.calls[1]![0]).toContain("$5::text")
  })

  it("calls the public unlock RPC with only bound event and trusted actor values", async () => {
    const { repository, query } = setup()
    await expect(repository.unlock(ACTOR, EVENT)).resolves.toBe(1)
    expect(query.mock.calls).toEqual([
      [
        "SELECT set_config('request.jwt.claims', $1, true)",
        [JSON.stringify({ sub: ACTOR, role: "authenticated" })],
      ],
      ["SELECT public.admin_unlock_event_fields($1::uuid)", [EVENT]],
    ])
  })

  it("propagates mutation failures so withTransaction rolls back", async () => {
    const { repository, query } = setup()
    const failure = Object.assign(new Error("ADMIN_EVENT_INVALID_PRICE"), { code: "P0001" })
    query.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(failure)
    await expect(
      repository.update(ACTOR, EVENT, {
        patch: { price: 2 },
        tagIds: [],
        lockEditedFields: true,
        decisionReason: null,
      })
    ).rejects.toBe(failure)
    expect(query).toHaveBeenCalledTimes(2)
  })
})
