import { Injectable } from "@nestjs/common"

import { DbService } from "../db/db.service.js"
import type { Rating } from "./types.js"

// Ported from family-events-app src/server/ratings.ts

const GET_SQL = `
SELECT id::text, user_id::text, event_id::text, score, created_at
FROM public.ratings
WHERE user_id = $1::uuid AND event_id = $2::uuid
`

const UPSERT_SQL = `
INSERT INTO public.ratings (user_id, event_id, score)
VALUES ($1::uuid, $2::uuid, $3)
ON CONFLICT (user_id, event_id)
DO UPDATE SET score = excluded.score
RETURNING id::text, user_id::text, event_id::text, score, created_at
`

@Injectable()
export class RatingsRepository {
  constructor(private readonly db: DbService) {}

  async getUserEventRating(userKey: string, eventId: string): Promise<Rating | null> {
    const rows = await this.db.query<Rating>(GET_SQL, [userKey, eventId])
    return rows[0] ?? null
  }

  async upsertEventRating(userKey: string, eventId: string, score: number): Promise<Rating> {
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      throw new Error("Rating score must be an integer from 1 to 5")
    }
    const rows = await this.db.query<Rating>(UPSERT_SQL, [userKey, eventId, score])
    return rows[0]!
  }
}
