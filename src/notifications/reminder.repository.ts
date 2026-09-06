import { Injectable } from "@nestjs/common"

import { DbService } from "../db/db.service.js"

export interface ReminderTarget {
  userId: string
  email: string | null
  displayName: string | null
  eventId: string
  title: string
  startDatetime: string
  venueName: string | null
  address: string | null
  reminderEmail: boolean | null
  reminderPush: boolean | null
}

export interface ReminderInAppNotificationRow {
  id: string
  userId: string
  type: "reminder"
  title: string
  body: string
  eventId: string
}

const FIND_REMINDER_TARGETS_SQL = `
SELECT
  f.user_id AS "userId",
  p.email,
  p.display_name AS "displayName",
  f.event_id AS "eventId",
  e.title,
  e.start_datetime AS "startDatetime",
  e.venue_name AS "venueName",
  e.address,
  unp.reminder_email AS "reminderEmail",
  unp.reminder_push AS "reminderPush"
FROM public.favorites f
JOIN public.events e ON e.id = f.event_id
  AND e.status = 'published'
  AND e.start_datetime >= $1::timestamptz
  AND e.start_datetime < $2::timestamptz
LEFT JOIN public.user_profiles p ON p.id = f.user_id
LEFT JOIN public.user_notification_preferences unp ON unp.user_id = f.user_id
ORDER BY f.user_id, e.start_datetime, e.id
`

const INSERT_IN_APP_SQL = `
INSERT INTO public.user_notifications (id, user_id, type, title, body, event_id)
SELECT *
FROM UNNEST(
  $1::uuid[],
  $2::uuid[],
  $3::text[],
  $4::text[],
  $5::text[],
  $6::uuid[]
)
ON CONFLICT (id) DO NOTHING
RETURNING id
`

@Injectable()
export class ReminderRepository {
  constructor(private readonly db: DbService) {}

  async findReminderTargets(input: {
    windowStart: string
    windowEnd: string
  }): Promise<ReminderTarget[]> {
    return this.db.query<ReminderTarget>(FIND_REMINDER_TARGETS_SQL, [
      input.windowStart,
      input.windowEnd,
    ])
  }

  async insertInAppNotifications(rows: ReminderInAppNotificationRow[]): Promise<number> {
    if (rows.length === 0) return 0
    const inserted = await this.db.query<{ id: string }>(INSERT_IN_APP_SQL, [
      rows.map((row) => row.id),
      rows.map((row) => row.userId),
      rows.map((row) => row.type),
      rows.map((row) => row.title),
      rows.map((row) => row.body),
      rows.map((row) => row.eventId),
    ])
    return inserted.length
  }

  async insertInAppNotification(row: ReminderInAppNotificationRow): Promise<number> {
    return this.insertInAppNotifications([row])
  }
}
