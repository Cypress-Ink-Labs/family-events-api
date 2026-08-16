import { Injectable } from "@nestjs/common"

import { DbService } from "../db/db.service.js"
import type { CalendarEvent } from "./types.js"

// Ported from family-events-app src/server/calendar.ts

const LIST_SQL = `
SELECT
  c.event_id::text, c.added_at, c.notes,
  e.title, e.start_datetime, e.end_datetime, e.venue_name, e.address,
  e.city_id::text, e.is_free, e.price::text, e.images
FROM public.user_calendar_events c
JOIN public.events e ON e.id = c.event_id
WHERE c.user_id = $1::uuid
ORDER BY e.start_datetime ASC
`

const ADD_SQL = `
INSERT INTO public.user_calendar_events (user_id, event_id, notes)
VALUES ($1::uuid, $2::uuid, $3)
ON CONFLICT (user_id, event_id) DO NOTHING
`

const REMOVE_SQL = `
DELETE FROM public.user_calendar_events
WHERE user_id = $1::uuid AND event_id = $2::uuid
`

@Injectable()
export class CalendarRepository {
  constructor(private readonly db: DbService) {}

  async listCalendarEvents(userKey: string): Promise<CalendarEvent[]> {
    return this.db.query<CalendarEvent>(LIST_SQL, [userKey])
  }

  async addToCalendar(userKey: string, eventId: string, notes?: string | null): Promise<void> {
    await this.db.query(ADD_SQL, [userKey, eventId, notes ?? null])
  }

  async removeFromCalendar(userKey: string, eventId: string): Promise<void> {
    await this.db.query(REMOVE_SQL, [userKey, eventId])
  }
}
