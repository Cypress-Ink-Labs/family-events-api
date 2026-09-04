import { describe, expect, it, vi } from "vitest"

import type { DbService } from "../db/db.service.js"
import {
  NOTIFICATION_QUEUE_LOCK_ID,
  NotificationQueueRepository,
  type InAppNotificationRow,
  type NotificationQueueEntry,
} from "./notification-queue.repository.js"

function makeRepository() {
  const query = vi.fn<(text: string, params?: unknown[]) => Promise<unknown[]>>(async () => [])
  const client = {
    query: vi.fn(async () => ({ rows: [{ acquired: true }] })),
    release: vi.fn(),
  }
  return {
    query,
    client,
    repository: new NotificationQueueRepository({
      query,
      pool: { connect: vi.fn(async () => client) },
    } as unknown as DbService),
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

  it("parameterizes bulk in-app rows and matches finalization by id and selected timestamp", async () => {
    const { query, repository } = makeRepository()
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ markedCount: 2 }])
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
    const selected: Pick<NotificationQueueEntry, "id" | "createdAt">[] = [
      { id: "queue-1", createdAt: "2026-09-05T13:00:00Z" },
      { id: "queue-1", createdAt: "2026-09-05T13:00:00Z" },
      { id: "queue-2", createdAt: "2026-09-05T13:30:00Z" },
    ]
    await expect(repository.markProcessed(selected, "2026-09-05T15:00:00Z")).resolves.toBe(2)

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
    expect(markSql).toContain("UNNEST($1::uuid[], $2::timestamptz[])")
    expect(markSql).toContain("queue.created_at = selected.created_at")
    expect(markParams).toEqual([
      ["queue-1", "queue-2"],
      ["2026-09-05T13:00:00Z", "2026-09-05T13:30:00Z"],
      "2026-09-05T15:00:00Z",
    ])
  })

  it("holds and releases one session advisory lock around the run", async () => {
    const { client, repository } = makeRepository()
    const work = vi.fn(async () => "complete")

    await expect(repository.withExclusiveRun(work)).resolves.toEqual({
      acquired: true,
      value: "complete",
    })

    expect(client.query).toHaveBeenNthCalledWith(
      1,
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
      [NOTIFICATION_QUEUE_LOCK_ID]
    )
    expect(client.query).toHaveBeenNthCalledWith(2, "SELECT pg_advisory_unlock($1::bigint)", [
      NOTIFICATION_QUEUE_LOCK_ID,
    ])
    expect(client.release).toHaveBeenCalledTimes(1)
  })

  it("does no work when another session owns the advisory lock", async () => {
    const { client, repository } = makeRepository()
    client.query.mockResolvedValueOnce({ rows: [{ acquired: false }] })
    const work = vi.fn(async () => "complete")

    await expect(repository.withExclusiveRun(work)).resolves.toEqual({ acquired: false })
    expect(work).not.toHaveBeenCalled()
    expect(client.query).toHaveBeenCalledTimes(1)
    expect(client.release).toHaveBeenCalledTimes(1)
  })
})
