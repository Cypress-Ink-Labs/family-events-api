import { Injectable } from "@nestjs/common"

import { DbService } from "../db/db.service.js"
import type { Favorite } from "./types.js"

// Ported from family-events-app src/server/favorites.ts

const LIST_SQL = `
SELECT id::text, user_id::text, event_id::text, created_at
FROM public.favorites
WHERE user_id = $1::uuid
ORDER BY created_at DESC
`

const ADD_SQL = `
INSERT INTO public.favorites (user_id, event_id)
VALUES ($1::uuid, $2::uuid)
ON CONFLICT (user_id, event_id) DO NOTHING
`

const REMOVE_SQL = `
DELETE FROM public.favorites
WHERE user_id = $1::uuid AND event_id = $2::uuid
`

@Injectable()
export class FavoritesRepository {
  constructor(private readonly db: DbService) {}

  async listFavorites(userKey: string): Promise<Favorite[]> {
    return this.db.query<Favorite>(LIST_SQL, [userKey])
  }

  async addFavorite(userKey: string, eventId: string): Promise<void> {
    await this.db.query(ADD_SQL, [userKey, eventId])
  }

  async removeFavorite(userKey: string, eventId: string): Promise<void> {
    await this.db.query(REMOVE_SQL, [userKey, eventId])
  }
}
