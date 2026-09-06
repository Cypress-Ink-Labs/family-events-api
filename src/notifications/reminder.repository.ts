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

  async insertInAppNotifications(rows: ReminderInAppNotificationRow[]): Promise<void> {
    if (rows.length === 0) return
    await this.db.query(INSERT_IN_APP_SQL, [
      rows.map((row) => row.userId),
      rows.map((row) => row.type),
      rows.map((row) => row.title),
      rows.map((row) => row.body),
      rows.map((row) => row.eventId),
    ])
  }

  async insertInAppNotification(row: ReminderInAppNotificationRow): Promise<void> {
    await this.insertInAppNotifications([row])
  }
}
