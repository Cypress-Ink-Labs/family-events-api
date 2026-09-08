import type { PoolClient } from "pg"
import { describe, expect, it, vi } from "vitest"

import type { DbService } from "../db/db.service.js"
import { AdminAccessDeniedError } from "./admin-database.js"
import type { AdminCreateSourceInput } from "./admin-source.input.js"
import {
  AdminSourceRepository,
  InactiveAdminSourceError,
  toDatabaseSourcePatch,
} from "./admin-source.repository.js"

const ACTOR = "11111111-1111-4111-8111-111111111111"
const SOURCE = "22222222-2222-4222-8222-222222222222"

const createInput: AdminCreateSourceInput = {
  name: "Calendar",
  url: "https://example.com/events",
  sourceType: "website",
  extractionMode: "deterministic_then_llm",
  processingMode: "auto_approve",
  cityId: null,
  isActive: true,
  scrapeIntervalHours: 24,
  notes: null,
  dateWindowDays: 30,
}

function setup() {
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql === "SELECT private.is_admin() AS allowed") return { rows: [{ allowed: true }] }
    if (sql.includes("SELECT is_active")) return { rows: [{ is_active: true }] }
    if (sql.includes("enqueue_source_scrape")) {
      return { rows: [{ queue_id: "9007199254740993", deduped: false }] }
    }
    return { rows: [{ id: SOURCE }] }
  })
  const withTransaction = vi.fn(async (work: (client: PoolClient) => Promise<unknown>) =>
    work({ query } as unknown as PoolClient)
  )
  return {
    query,
    withTransaction,
    repository: new AdminSourceRepository({ withTransaction } as unknown as DbService),
  }
}

describe("AdminSourceRepository", () => {
  it("maps only API-owned source patch fields and preserves nulls", () => {
    expect(
      toDatabaseSourcePatch({
        name: "Calendar",
        cityId: null,
        isActive: false,
        dateWindowDays: null,
      })
    ).toEqual({
      name: "Calendar",
      city_id: null,
      is_active: false,
      date_window_days: null,
    })
  })

  it("requires database authorization before direct source reads", async () => {
    const { repository, query } = setup()
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ allowed: false }] })
    await expect(repository.list(ACTOR)).rejects.toBeInstanceOf(AdminAccessDeniedError)
    expect(query).toHaveBeenCalledTimes(2)
  })

  it("lists sources under transaction-local actor claims", async () => {
    const { repository, query, withTransaction } = setup()
    await repository.list(ACTOR)
    expect(withTransaction).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0]).toEqual([
      "SELECT set_config('request.jwt.claims', $1, true)",
      [JSON.stringify({ sub: ACTOR, role: "authenticated" })],
    ])
    expect(query.mock.calls[1]).toEqual(["SELECT private.is_admin() AS allowed"])
    expect(query.mock.calls[2]![0]).toContain("ORDER BY created_at DESC, id")
  })

  it("creates then applies processing mode in the same actor transaction", async () => {
    const { repository, query, withTransaction } = setup()
    await repository.create(ACTOR, createInput)
    expect(withTransaction).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[1]![0]).toContain("public.admin_create_source")
    expect(query.mock.calls[1]![1]).toEqual([
      JSON.stringify({
        name: "Calendar",
        url: "https://example.com/events",
        source_type: "website",
        extraction_mode: "deterministic_then_llm",
        city_id: null,
        is_active: true,
        auto_approve: false,
        scrape_interval_hours: 24,
        notes: null,
        date_window_days: 30,
      }),
    ])
    expect(query.mock.calls[2]![0]).toContain("admin_set_event_source_processing_mode")
    expect(query.mock.calls[2]![1]).toEqual([SOURCE, "auto_approve"])
  })

  it("uses parameterized update and processing-mode RPCs", async () => {
    const { repository, query } = setup()
    await repository.update(ACTOR, SOURCE, { notes: "quote '", cityId: null })
    expect(query.mock.calls[1]).toEqual([
      expect.stringContaining("public.admin_update_source"),
      [SOURCE, JSON.stringify({ city_id: null, notes: "quote '" })],
    ])
    await repository.setProcessingMode(ACTOR, SOURCE, "auto_approve")
    expect(query.mock.calls[3]).toEqual([
      expect.stringContaining("public.admin_set_event_source_processing_mode"),
      [SOURCE, "auto_approve"],
    ])
    await repository.bulkSetProcessingMode(ACTOR, "manual_review")
    expect(query.mock.calls[5]).toEqual([
      "SELECT public.admin_bulk_set_processing_mode($1::public.event_processing_mode)",
      ["manual_review"],
    ])
  })

  it("locks and authorizes an active source before durable enqueue", async () => {
    const { repository, query } = setup()
    await expect(repository.scrape(ACTOR, SOURCE)).resolves.toEqual({
      queueId: "9007199254740993",
      deduped: false,
    })
    expect(query.mock.calls).toEqual([
      [
        "SELECT set_config('request.jwt.claims', $1, true)",
        [JSON.stringify({ sub: ACTOR, role: "authenticated" })],
      ],
      ["SELECT private.is_admin() AS allowed"],
      ["SELECT is_active FROM public.event_sources WHERE id = $1::uuid FOR UPDATE", [SOURCE]],
      [expect.stringContaining("public.enqueue_source_scrape"), [SOURCE]],
      ["UPDATE public.event_sources SET last_status = 'pending' WHERE id = $1::uuid", [SOURCE]],
    ])
  })

  it("does not enqueue missing or inactive sources", async () => {
    const { repository, query } = setup()
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ allowed: true }] })
      .mockResolvedValueOnce({ rows: [] })
    await expect(repository.scrape(ACTOR, SOURCE)).resolves.toBeNull()
    expect(query).toHaveBeenCalledTimes(3)

    const inactive = setup()
    inactive.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ allowed: true }] })
      .mockResolvedValueOnce({ rows: [{ is_active: false }] })
    await expect(inactive.repository.scrape(ACTOR, SOURCE)).rejects.toBeInstanceOf(
      InactiveAdminSourceError
    )
    expect(inactive.query).toHaveBeenCalledTimes(3)
  })
})
