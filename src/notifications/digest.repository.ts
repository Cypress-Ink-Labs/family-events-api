import { Injectable } from "@nestjs/common"

import { DbService } from "../db/db.service.js"

export interface DigestUser {
  userId: string
  email: string
  displayName: string | null
  childAge: number | null
  cityName: string
  lat: number | null
  lng: number | null
  cityIds: string[]
}

interface DigestUserRow extends Omit<DigestUser, "cityIds"> {
  primaryCityId: string
}

interface PreferredCityRow {
  userId: string
  cityId: string
}

const DIGEST_USERS_SELECT = `
SELECT
  unp.user_id AS "userId",
  p.email,
  p.display_name AS "displayName",
  p.child_age AS "childAge",
  p.city_preference_id AS "primaryCityId",
  c.name AS "cityName",
  c.latitude::double precision AS lat,
  c.longitude::double precision AS lng
FROM public.user_notification_preferences unp
JOIN public.user_profiles p ON p.id = unp.user_id
  AND p.email IS NOT NULL
JOIN public.cities c ON c.id = p.city_preference_id
WHERE unp.digest_email IS TRUE
`

@Injectable()
export class DigestRepository {
  constructor(private readonly db: DbService) {}

  async listDigestUsers(after: string | null, limit: number): Promise<DigestUser[]> {
    const rows = await this.db.query<DigestUserRow>(
      `${DIGEST_USERS_SELECT}
       AND ($1::uuid IS NULL OR unp.user_id > $1::uuid)
       ORDER BY unp.user_id
       LIMIT $2`,
      [after, limit]
    )
    return this.withPreferredCities(rows)
  }

  async findDigestUserByEmail(email: string): Promise<DigestUser | null> {
    const rows = await this.db.query<DigestUserRow>(
      `${DIGEST_USERS_SELECT}
       AND lower(p.email) = lower($1)
       ORDER BY unp.user_id
       LIMIT 1`,
      [email]
    )
    return (await this.withPreferredCities(rows))[0] ?? null
  }

  private async withPreferredCities(rows: DigestUserRow[]): Promise<DigestUser[]> {
    if (rows.length === 0) return []
    const preferred = await this.db.query<PreferredCityRow>(
      `SELECT user_id AS "userId", city_id AS "cityId"
       FROM public.user_preferred_cities
       WHERE user_id = ANY($1::uuid[])
       ORDER BY user_id, created_at, city_id`,
      [rows.map((row) => row.userId)]
    )
    const byUser = new Map<string, string[]>()
    for (const row of preferred) {
      const cities = byUser.get(row.userId) ?? []
      cities.push(row.cityId)
      byUser.set(row.userId, cities)
    }
    return rows.map(({ primaryCityId, ...row }) => ({
      ...row,
      cityIds: byUser.get(row.userId) ?? [primaryCityId],
    }))
  }
}
