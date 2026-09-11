import { ForbiddenException, NotFoundException } from "@nestjs/common"
import { describe, expect, it, vi } from "vitest"

import { CRON_LABELS } from "./admin-cron.input.js"
import { AdminCronService } from "./admin-cron.service.js"

const timestamp = "2026-06-01 00:00:00.123456+00"
const summary = {
  id: "9223372036854775806",
  label: CRON_LABELS[0]!,
  status: "succeeded",
  ran_at: timestamp,
  duration_s: 2,
  http_status: 200,
}

describe("AdminCronService", () => {
  it("maps gates, code-owned metadata, defaults, internal null gates, and latest runs", async () => {
    const repository = {
      gatesAndLatest: vi.fn().mockResolvedValue([
        {
          ...summary,
          legacy_enabled: false,
          nest_enabled: true,
        },
      ]),
    }
    const result = await new AdminCronService(repository as never).schedules("actor")
    const replaced = result.items.find((item) => item.replaces === CRON_LABELS[0])
    expect(replaced).toMatchObject({
      legacy_enabled: false,
      nest_enabled: true,
      latest_run: summary,
    })
    expect(result.items.find((item) => item.replaces === null)).toMatchObject({
      legacy_enabled: null,
      nest_enabled: null,
      latest_run: null,
    })
    expect(repository.gatesAndLatest).toHaveBeenCalledWith("actor", CRON_LABELS)
  })

  it("preserves bigint ids, raw timestamps, and the full log projection", async () => {
    const detail = {
      ...summary,
      run_key: "10000000-0000-4000-8000-000000000001",
      body: null,
      logs: [
        {
          id: "9223372036854775807",
          provider: "supabase",
          level: "warn",
          message: "message",
          metadata: { attempt: 2 },
          sequence: null,
          created_at: timestamp,
        },
      ],
    }
    const service = new AdminCronService({ detail: vi.fn().mockResolvedValue(detail) } as never)
    expect(await service.detail("actor", detail.id)).toEqual(detail)
  })

  it("maps denial and missing rows, and rejects schema drift", async () => {
    await expect(
      new AdminCronService({
        runs: vi.fn().mockRejectedValue({ code: "42501", message: "denied" }),
      } as never).runs("actor", undefined, 50)
    ).rejects.toBeInstanceOf(ForbiddenException)
    await expect(
      new AdminCronService({ detail: vi.fn().mockResolvedValue(undefined) } as never).detail(
        "actor",
        "1"
      )
    ).rejects.toBeInstanceOf(NotFoundException)
    await expect(
      new AdminCronService({
        runs: vi.fn().mockResolvedValue([{ ...summary, unexpected: true }]),
      } as never).runs("actor", undefined, 50)
    ).rejects.toThrow()
  })
})
