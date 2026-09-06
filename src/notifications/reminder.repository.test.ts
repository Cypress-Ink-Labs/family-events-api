import { describe, expect, it, vi } from "vitest"

import type { DbService } from "../db/db.service.js"
import { ReminderRepository, type ReminderInAppNotificationRow } from "./reminder.repository.js"

function makeRepository() {
  const query = vi.fn<(text: string, params?: unknown[]) => Promise<unknown[]>>(async () => [])
  return { query, repository: new ReminderRepository({ query } as unknown as DbService) }
}

describe("ReminderRepository", () => {
  it("selects reminder targets without filtering by an external channel", async () => {
    const { query, repository } = makeRepository()
    await repository.findReminderTargets({
      windowStart: "2026-09-05T05:00:00.000Z",
      windowEnd: "2026-09-06T05:00:00.000Z",
    })

    const [sql, params] = query.mock.calls[0]!
    expect(sql).toContain("e.status = 'published'")
    expect(sql).toContain('unp.reminder_push AS "reminderPush"')
    expect(sql).not.toContain("IS NOT FALSE")
    expect(sql).not.toContain("nullif(p.email")
    expect(params).toEqual(["2026-09-05T05:00:00.000Z", "2026-09-06T05:00:00.000Z"])
  })

  it("parameterizes aligned bulk in-app reminder rows", async () => {
    const { query, repository } = makeRepository()
    const rows: ReminderInAppNotificationRow[] = [
      {
        id: "aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa",
        userId: "11111111-1111-4111-8111-111111111111",
        type: "reminder",
        title: "Reminder",
        body: "Today",
        eventId: "22222222-2222-4222-8222-222222222222",
      },
    ]

    await repository.insertInAppNotifications(rows)

    const [sql, params] = query.mock.calls[0]!
    expect(sql).toContain("INSERT INTO public.user_notifications")
    expect(sql).toContain("UNNEST")
    expect(sql).toContain("ON CONFLICT (id) DO NOTHING")
    expect(sql).not.toContain(rows[0]!.title)
    expect(params).toEqual([
      [rows[0]!.id],
      [rows[0]!.userId],
      ["reminder"],
      ["Reminder"],
      ["Today"],
      [rows[0]!.eventId],
    ])
  })
})
