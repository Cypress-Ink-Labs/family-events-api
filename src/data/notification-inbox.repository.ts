import { Injectable, NotFoundException } from "@nestjs/common"
import { DbService } from "../db/db.service.js"
import type { NotificationInboxDto } from "../consumer/notification.dto.js"

@Injectable()
export class NotificationInboxRepository {
  constructor(private readonly db: DbService) {}

  async get(userId: string): Promise<NotificationInboxDto> {
    const [inbox] = await this.db.query<NotificationInboxDto>(
      `
      WITH latest AS (
        SELECT id, type, title, body, event_id, read_at, created_at
        FROM public.user_notifications WHERE user_id = $1::uuid
        ORDER BY created_at DESC, id DESC LIMIT 20
      )
      SELECT COALESCE((SELECT json_agg(latest ORDER BY created_at DESC, id DESC) FROM latest), '[]'::json) AS items,
        (SELECT count(*)::integer FROM public.user_notifications WHERE user_id = $1::uuid AND read_at IS NULL) AS unread_count
    `,
      [userId]
    )
    return inbox!
  }

  async markRead(userId: string, id: string): Promise<NotificationInboxDto> {
    const rows = await this.db.query<{ id: string }>(
      "UPDATE public.user_notifications SET read_at = COALESCE(read_at, now()) WHERE user_id = $1::uuid AND id = $2::uuid RETURNING id",
      [userId, id]
    )
    if (!rows.length) throw new NotFoundException("Notification not found")
    return this.get(userId)
  }

  async markAllRead(userId: string): Promise<NotificationInboxDto> {
    await this.db.query(
      "UPDATE public.user_notifications SET read_at = now() WHERE user_id = $1::uuid AND read_at IS NULL",
      [userId]
    )
    return this.get(userId)
  }
}
