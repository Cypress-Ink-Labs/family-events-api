import { Injectable } from "@nestjs/common"

import { DbService } from "../db/db.service.js"

export interface ReminderTarget {
  userId: string
  email: string
  displayName: string | null
  eventId: string
  title: string
  startDatetime: string
  venueName: string | null
  address: string | null
  reminderEmail: boolean | null
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
  unp.reminder_email AS "reminderEmail"
FROM public.favorites f
JOIN public.events e ON e.id = f.event_id
  AND e.status = 'published'
  AND e.start_datetime >= $1::timestamptz
  AND e.start_datetime < $2::timestamptz
JOIN public.user_profiles p ON p.id = f.user_id
  AND nullif(p.email, '') IS NOT NULL
LEFT JOIN public.user_notification_preferences unp ON unp.user_id = f.user_id
WHERE unp.reminder_email IS NOT FALSE
ORDER BY f.user_id, e.start_datetime, e.id
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
}
