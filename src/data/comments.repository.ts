import { Injectable } from "@nestjs/common"

import { DbService } from "../db/db.service.js"
import type { EventComment } from "./types.js"

// Ported from family-events-app src/server/comments.ts

const LIST_SQL = `
SELECT
  c.id::text, c.user_id::text, c.event_id::text, c.body,
  c.is_approved, c.is_flagged, c.created_at, c.updated_at,
  p.display_name, p.avatar_url
FROM public.comments c
LEFT JOIN public.user_profiles p ON p.id = c.user_id
WHERE c.event_id = $1::uuid AND c.is_approved = true
ORDER BY c.created_at DESC
`

const ADD_SQL = `
INSERT INTO public.comments (user_id, event_id, body, is_approved, is_flagged)
VALUES ($1::uuid, $2::uuid, $3, true, false)
RETURNING id::text
`

const DELETE_OWN_SQL = `
DELETE FROM public.comments
WHERE id = $1::uuid AND user_id = $2::uuid
RETURNING id
`

@Injectable()
export class CommentsRepository {
  constructor(private readonly db: DbService) {}

  async listEventComments(eventId: string): Promise<EventComment[]> {
    return this.db.query<EventComment>(LIST_SQL, [eventId])
  }

  async addEventComment(userKey: string, eventId: string, body: string): Promise<{ id: string }> {
    const trimmed = body.trim()
    if (!trimmed) {
      throw new Error("Comment body is required")
    }
    const rows = await this.db.query<{ id: string }>(ADD_SQL, [userKey, eventId, trimmed])
    return rows[0]!
  }

  async deleteOwnComment(userKey: string, commentId: string): Promise<boolean> {
    const rows = await this.db.query(DELETE_OWN_SQL, [commentId, userKey])
    return rows.length > 0
  }
}
