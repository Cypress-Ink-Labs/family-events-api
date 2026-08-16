import { Injectable } from "@nestjs/common"

import { DbService } from "../db/db.service.js"
import type { PreferredCity } from "./types.js"

// Ported from family-events-app src/server/preferred-cities.ts

const LIST_SQL = `
SELECT user_id::text, city_id::text, is_primary, created_at
FROM public.user_preferred_cities
WHERE user_id = $1::uuid
ORDER BY created_at ASC
`

const DELETE_DESELECTED_SQL = `
DELETE FROM public.user_preferred_cities
WHERE user_id = $1::uuid
  AND city_id <> ALL ($2::uuid[])
`

const DEMOTE_PRIMARY_SQL = `
UPDATE public.user_preferred_cities
SET is_primary = false
WHERE user_id = $1::uuid AND is_primary AND city_id <> $2::uuid
`

const UPSERT_SQL = `
INSERT INTO public.user_preferred_cities (user_id, city_id, is_primary)
SELECT $1::uuid, c.city_id, (c.city_id = $2::uuid)
FROM unnest($3::uuid[]) AS c(city_id)
ON CONFLICT (user_id, city_id)
DO UPDATE SET is_primary = excluded.is_primary
`

const MIRROR_PROFILE_SQL = `
UPDATE public.user_profiles
SET city_preference_id = $1::uuid
WHERE id = $2::uuid
`

@Injectable()
export class PreferredCitiesRepository {
  constructor(private readonly db: DbService) {}

  async listPreferredCities(userKey: string): Promise<PreferredCity[]> {
    return this.db.query<PreferredCity>(LIST_SQL, [userKey])
  }

  async setPreferredCities(
    userKey: string,
    cityIds: readonly string[],
    primaryCityId: string
  ): Promise<void> {
    const uniqueCityIds = Array.from(new Set(cityIds))
    if (uniqueCityIds.length === 0) {
      throw new Error("set_preferred_cities: city set must be non-empty")
    }
    if (!uniqueCityIds.includes(primaryCityId)) {
      throw new Error("set_preferred_cities: primary city must be one of the selected cities")
    }

    await this.db.withTransaction(async (client) => {
      await client.query(DELETE_DESELECTED_SQL, [userKey, uniqueCityIds])
      // Demote any old primary before the upsert: the one-primary partial
      // unique index is enforced per row, so promoting the new primary first
      // violates it.
      await client.query(DEMOTE_PRIMARY_SQL, [userKey, primaryCityId])
      await client.query(UPSERT_SQL, [userKey, primaryCityId, uniqueCityIds])
      await client.query(MIRROR_PROFILE_SQL, [primaryCityId, userKey])
    })
  }
}
