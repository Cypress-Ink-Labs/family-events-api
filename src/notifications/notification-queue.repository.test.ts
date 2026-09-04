import { describe, expect, it, vi } from "vitest"

import type { DbService } from "../db/db.service.js"
import {
  NotificationQueueRepository,
  type InAppNotificationRow,
} from "./notification-queue.repository.js"

function makeRepository() {
  const query = vi.fn<(text: string, params?: unknown[]) => Promise<unknown[]>>(async () => [])
  return {
    query,
    repository: new NotificationQueueRepository({ query } as unknown as DbService),
  }
}

describe("NotificationQueueRepository", () => {
  it("lists at most 100 eligible rows in stable order using the cutoff parameter", async () => {
    const { query, repository } = makeRepository()
    const cutoff = "2026-09-05T14:00:00.000Z"

    await repository.listPending(cutoff)

    const [sql, params] = query.mock.calls[0]!
    expect(sql).toContain("processed IS FALSE")
    expect(sql).toContain("created_at < $1::timestamptz")
    expect(sql).toContain("ORDER BY created_at, id")
    expect(sql).toContain("LIMIT 100")
    expect(sql).not.toContain(cutoff)
    expect(params).toEqual([cutoff])
  })

  it("deduplicates IDs independently for each hydration query", async () => {
    const { query, repository } = makeRepository()

    await repository.hydrateEvents(["event-1", "event-1", "event-2"])
    await repository.hydrateProfiles(["user-1", "user-1"])
    await repository.hydratePreferences(["user-1", "user-1"])

    expect(query.mock.calls.map((call) => call[1])).toEqual([
      [["event-1", "event-2"]],
      [["user-1"]],
      [["user-1"]],
    ])
  })

  it("parameterizes bulk in-app rows and the processed marker", async () => {
    const { query, repository } = makeRepository()
    const rows: InAppNotificationRow[] = [
      {
        userId: "user-1",
        type: "change",
        title: "Updated: Event",
        body: "The event time has changed.",
        eventId: "event-1",
      },
      {
        userId: "user-2",
        type: "change",
        title: "Cancelled: Event",
        body: "This event has been cancelled.",
        eventId: "event-1",
      },
    ]

    await repository.insertInAppNotifications(rows)
    await repository.markProcessed(["queue-1", "queue-1", "queue-2"], "2026-09-05T15:00:00Z")

    const [insertSql, insertParams] = query.mock.calls[0]!
    expect(insertSql).toContain("UNNEST")
    expect(insertSql).not.toContain("Updated: Event")
    expect(insertParams).toEqual([
      ["user-1", "user-2"],
      ["change", "change"],
      ["Updated: Event", "Cancelled: Event"],
      ["The event time has changed.", "This event has been cancelled."],
      ["event-1", "event-1"],
    ])
    const [markSql, markParams] = query.mock.calls[1]!
    expect(markSql).toContain("processed_at = $2::timestamptz")
    expect(markParams).toEqual([["queue-1", "queue-2"], "2026-09-05T15:00:00Z"])
  })
})
