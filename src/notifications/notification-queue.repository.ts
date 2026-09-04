import { Injectable } from "@nestjs/common"

import { DbService } from "../db/db.service.js"

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
UPDATE public.notification_queue
SET processed = TRUE,
    processed_at = $2::timestamptz
WHERE id = ANY($1::uuid[])
  AND processed IS FALSE
`

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

@Injectable()
export class NotificationQueueRepository {
  constructor(private readonly db: DbService) {}

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

  async markProcessed(ids: string[], processedAt: string): Promise<void> {
    const uniqueIds = unique(ids)
    if (uniqueIds.length === 0) return
    await this.db.query(MARK_PROCESSED_SQL, [uniqueIds, processedAt])
  }
}
