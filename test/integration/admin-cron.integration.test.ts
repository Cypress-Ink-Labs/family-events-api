import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { CRON_LABELS } from "../../src/admin/admin-cron.input.js"
import { AdminCronRepository } from "../../src/admin/admin-cron.repository.js"
import { AdminCronService } from "../../src/admin/admin-cron.service.js"
import type { DbService } from "../../src/db/db.service.js"

import { ensureAdminCatalog, truncateAdminCatalog } from "./admin-catalog.js"
import { createIntegrationDb } from "./db.js"

const ADMIN = "11111111-1111-4111-8111-111111111111"
const NON_ADMIN = "22222222-2222-4222-8222-222222222222"

describe("admin cron PostgreSQL integration", () => {
  let db: DbService
  let service: AdminCronService

  beforeAll(async () => {
    db = createIntegrationDb()
    await ensureAdminCatalog(db)
    service = new AdminCronService(new AdminCronRepository(db))
  })
  beforeEach(async () => {
    await truncateAdminCatalog(db)
    await db.query("INSERT INTO auth.users (id) VALUES ($1), ($2)", [ADMIN, NON_ADMIN])
    await db.query(
      "INSERT INTO public.user_profiles (id, role) VALUES ($1, 'admin'), ($2, 'user')",
      [ADMIN, NON_ADMIN]
    )
    await db.query(
      "INSERT INTO public.user_access (user_id, is_enabled) VALUES ($1, true), ($2, true)",
      [ADMIN, NON_ADMIN]
    )
  })
  afterAll(async () => db.onModuleDestroy())

  it("returns code-owned schedules with defaults, overrides, null internal gates and latest summary", async () => {
    const label = CRON_LABELS[0]!
    await db.query(
      "INSERT INTO private.cron_enabled(label, enabled) VALUES ($1, false), ('nestjs:' || $1, true)",
      [label]
    )
    await db.query(
      `INSERT INTO private.railway_cron_runs
         (id, run_key, label, status, ran_at, duration_s, http_status)
       VALUES (9223372036854775806, gen_random_uuid(), $1, 'succeeded',
               '2026-06-01 00:00:00.123456+00', 7, 200)`,
      [label]
    )
    const result = await service.schedules(ADMIN)
    expect(result.items.find((item) => item.replaces === label)).toMatchObject({
      legacy_enabled: false,
      nest_enabled: true,
      latest_run: {
        id: "9223372036854775806",
        ran_at: "2026-06-01 00:00:00.123456+00",
        duration_s: 7,
        http_status: 200,
      },
    })
    expect(result.items.find((item) => item.replaces === null)).toMatchObject({
      legacy_enabled: null,
      nest_enabled: null,
      latest_run: null,
    })
  })

  it("allowlists history and returns bigint ids and raw microsecond timestamps", async () => {
    await db.query(
      `INSERT INTO private.railway_cron_runs(id, label, status, ran_at)
       VALUES (9223372036854775807, $1, 'succeeded', '2026-06-01 00:00:00.654321+00'),
              (10, 'not-code-owned', 'succeeded', now())`,
      [CRON_LABELS[0]]
    )
    expect(await service.runs(ADMIN, undefined, 200)).toEqual({
      items: [
        expect.objectContaining({
          id: "9223372036854775807",
          ran_at: "2026-06-01 00:00:00.654321+00",
        }),
      ],
    })
  })

  it("joins logs by run_key, orders them, and returns their full shape", async () => {
    const runKey = "33333333-3333-4333-8333-333333333333"
    await db.query(
      `INSERT INTO private.railway_cron_runs(id, run_key, label, status, ran_at)
       VALUES (99, $1, $2, 'succeeded', '2026-06-01 00:00:00.123456+00')`,
      [runKey, CRON_LABELS[0]]
    )
    await db.query(
      `INSERT INTO private.cron_run_log_entries
         (id, run_key, label, provider, level, message, metadata, sequence, created_at)
       VALUES (9223372036854775807, $1, $2, 'supabase', 'warn', 'second',
               '{"attempt":2}', 2, '2026-06-01 00:00:02.654321+00'),
              (11, $1, $2, 'railway', 'info', 'first',
               '{}', 1, '2026-06-01 00:00:01.123456+00')`,
      [runKey, CRON_LABELS[0]]
    )
    expect((await service.detail(ADMIN, "99")).logs).toEqual([
      {
        id: "11",
        provider: "railway",
        level: "info",
        message: "first",
        metadata: {},
        sequence: 1,
        created_at: "2026-06-01 00:00:01.123456+00",
      },
      expect.objectContaining({
        id: "9223372036854775807",
        provider: "supabase",
        level: "warn",
        sequence: 2,
      }),
    ])
  })

  it("returns empty logs, 404 for missing detail, and 403 for database denial", async () => {
    await db.query(
      "INSERT INTO private.railway_cron_runs(id, label, status) VALUES (1, $1, 'succeeded')",
      [CRON_LABELS[0]]
    )
    expect((await service.detail(ADMIN, "1")).logs).toEqual([])
    await expect(service.detail(ADMIN, "2")).rejects.toMatchObject({ status: 404 })
    await expect(service.runs(NON_ADMIN, undefined, 50)).rejects.toMatchObject({ status: 403 })
  })
})
