import { Injectable } from "@nestjs/common"
import { DbService } from "../db/db.service.js"

export interface SavedEventRecord {
  event_id: string
  calendar_notes: string | null
  calendar_added_at: string | null
  my_rating: number | null
}

@Injectable()
export class SavedEventsRepository {
  constructor(private readonly db: DbService) {}

  async remove(userId: string, eventId: string): Promise<void> {
    await this.db.withTransaction(async (client) => {
      await client.query(
        "DELETE FROM public.favorites WHERE user_id=$1::uuid AND event_id=$2::uuid",
        [userId, eventId]
      )
      await client.query(
        "DELETE FROM public.user_calendar_events WHERE user_id=$1::uuid AND event_id=$2::uuid",
        [userId, eventId]
      )
    })
  }

  list(userId: string): Promise<SavedEventRecord[]> {
    return this.db.query<SavedEventRecord>(
      `
      WITH saved AS (
        SELECT event_id FROM public.favorites WHERE user_id = $1::uuid
        UNION SELECT event_id FROM public.user_calendar_events WHERE user_id = $1::uuid
      )
      SELECT saved.event_id, c.notes AS calendar_notes, c.added_at AS calendar_added_at, r.score AS my_rating
      FROM saved LEFT JOIN public.user_calendar_events c ON c.event_id = saved.event_id AND c.user_id = $1::uuid
      LEFT JOIN public.ratings r ON r.event_id = saved.event_id AND r.user_id = $1::uuid
      ORDER BY saved.event_id`,
      [userId]
    )
  }
}
