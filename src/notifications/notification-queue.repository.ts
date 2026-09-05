import { Injectable } from "@nestjs/common"

import { DbService } from "../db/db.service.js"

// Stable signed 64-bit namespace key reserved for the U30 notification queue.
export const NOTIFICATION_QUEUE_LOCK_ID = "564679841717855333"

export type ExclusiveRunResult<T> = { acquired: false } | { acquired: true; value: T }

export type NotificationChangeType =
  | "time_changed"
  | "venue_changed"
  | "cancelled"
  | "status_changed"

export interface NotificationQueueEntry {
  id: string
  userId: string
  eventId: string
  changeType: NotificationChangeType
  changeDetail: Record<string, unknown> | null
  createdAt: string
}

export interface NotificationEventRow {
  id: string
  title: string
  startDatetime: string
  venueName: string | null
  address: string | null
  status: string
}

export interface NotificationProfileRow {
  id: string
  email: string | null
  displayName: string | null
}

export interface NotificationPreferenceRow {
  userId: string
  changeEmail: boolean
  changePush: boolean
}

export interface InAppNotificationRow {
  userId: string
  type: "change"
  title: string
  body: string
  eventId: string
}

const LIST_PENDING_SQL = `
SELECT
  id,
  user_id AS "userId",
  event_id AS "eventId",
  change_type AS "changeType",
  change_detail AS "changeDetail",
  created_at AS "createdAt"
FROM public.notification_queue
WHERE processed IS FALSE
  AND created_at < $1::timestamptz
ORDER BY created_at, id
LIMIT 100
`

const HYDRATE_EVENTS_SQL = `
SELECT
  id,
  title,
  start_datetime AS "startDatetime",
  venue_name AS "venueName",
  address,
  status
FROM public.events
WHERE id = ANY($1::uuid[])
`

const HYDRATE_PROFILES_SQL = `
SELECT id, email, display_name AS "displayName"
FROM public.user_profiles
WHERE id = ANY($1::uuid[])
`

const HYDRATE_PREFERENCES_SQL = `
SELECT
  user_id AS "userId",
  change_email AS "changeEmail",
  change_push AS "changePush"
FROM public.user_notification_preferences
WHERE user_id = ANY($1::uuid[])
`

const INSERT_IN_APP_SQL = `
INSERT INTO public.user_notifications (user_id, type, title, body, event_id)
SELECT *
FROM UNNEST(
  $1::uuid[],
  $2::text[],
  $3::text[],
  $4::text[],
  $5::uuid[]
)
`

const MARK_PROCESSED_SQL = `
WITH selected AS (
  SELECT *
  FROM UNNEST($1::uuid[], $2::timestamptz[]) AS row(id, created_at)
), updated AS (
  UPDATE public.notification_queue AS queue
  SET processed = TRUE,
      processed_at = $3::timestamptz
  FROM selected
  WHERE queue.id = selected.id
    AND queue.created_at = selected.created_at
    AND queue.processed IS FALSE
  RETURNING queue.id
)
SELECT COUNT(*)::integer AS "markedCount"
FROM updated
`

interface AdvisoryLockRow {
  acquired: boolean
}

interface MarkedCountRow {
  markedCount: number
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

@Injectable()
export class NotificationQueueRepository {
  constructor(private readonly db: DbService) {}

  async withExclusiveRun<T>(work: () => Promise<T>): Promise<ExclusiveRunResult<T>> {
    const client = await this.db.pool.connect()
    let acquired = false
    try {
      const lock = await client.query<AdvisoryLockRow>(
        "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
        [NOTIFICATION_QUEUE_LOCK_ID]
      )
      acquired = lock.rows[0]?.acquired === true
      if (!acquired) return { acquired: false }
      return { acquired: true, value: await work() }
    } finally {
      try {
        if (acquired) {
          await client.query("SELECT pg_advisory_unlock($1::bigint)", [NOTIFICATION_QUEUE_LOCK_ID])
        }
      } finally {
        client.release()
      }
    }
  }

  async listPending(cutoff: string): Promise<NotificationQueueEntry[]> {
    return this.db.query<NotificationQueueEntry>(LIST_PENDING_SQL, [cutoff])
  }

  async hydrateEvents(eventIds: string[]): Promise<NotificationEventRow[]> {
    const ids = unique(eventIds)
    if (ids.length === 0) return []
    return this.db.query<NotificationEventRow>(HYDRATE_EVENTS_SQL, [ids])
  }

  async hydrateProfiles(userIds: string[]): Promise<NotificationProfileRow[]> {
    const ids = unique(userIds)
    if (ids.length === 0) return []
    return this.db.query<NotificationProfileRow>(HYDRATE_PROFILES_SQL, [ids])
  }

  async hydratePreferences(userIds: string[]): Promise<NotificationPreferenceRow[]> {
    const ids = unique(userIds)
    if (ids.length === 0) return []
    return this.db.query<NotificationPreferenceRow>(HYDRATE_PREFERENCES_SQL, [ids])
  }

  async insertInAppNotifications(rows: InAppNotificationRow[]): Promise<void> {
    if (rows.length === 0) return
    await this.db.query(INSERT_IN_APP_SQL, [
      rows.map((row) => row.userId),
      rows.map((row) => row.type),
      rows.map((row) => row.title),
      rows.map((row) => row.body),
      rows.map((row) => row.eventId),
    ])
  }

  async insertInAppNotification(row: InAppNotificationRow): Promise<void> {
    await this.insertInAppNotifications([row])
  }

  async markProcessed(
    entries: Pick<NotificationQueueEntry, "id" | "createdAt">[],
    processedAt: string
  ): Promise<number> {
    const uniqueEntries = [...new Map(entries.map((entry) => [entry.id, entry])).values()]
    if (uniqueEntries.length === 0) return 0
    const rows = await this.db.query<MarkedCountRow>(MARK_PROCESSED_SQL, [
      uniqueEntries.map((entry) => entry.id),
      uniqueEntries.map((entry) => entry.createdAt),
      processedAt,
    ])
    return rows[0]?.markedCount ?? 0
  }
}
