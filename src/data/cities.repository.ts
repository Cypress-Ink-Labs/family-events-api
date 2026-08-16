import { Injectable } from "@nestjs/common"

import { DbService } from "../db/db.service.js"
import type { City } from "./public-event.js"

interface CityRow {
  id: string
  name: string
  slug: string
  state: string | null
  country: string
  timezone: string
  latitude: number | null
  longitude: number | null
  is_active: boolean
}

const LIST_SQL = `
SELECT id, name, slug, state, country, timezone, latitude, longitude, is_active
FROM public.cities
WHERE is_active = true
ORDER BY name ASC
`

const GET_SQL = `
SELECT id, name, slug, state, country, timezone, latitude, longitude, is_active
FROM public.cities
WHERE id = $1
`

function projectCity(row: CityRow): City {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    state: row.state,
    country: row.country,
    timezone: row.timezone,
    latitude: row.latitude,
    longitude: row.longitude,
    isActive: row.is_active,
  }
}

/** U23: city catalog reads. Inactive cities stay hidden from the public list. */
@Injectable()
export class CitiesRepository {
  constructor(private readonly db: DbService) {}

  async listActive(): Promise<City[]> {
    const rows = await this.db.query<CityRow>(LIST_SQL)
    return rows.map(projectCity)
  }

  async findById(id: string): Promise<City | null> {
    const rows = await this.db.query<CityRow>(GET_SQL, [id])
    const row = rows[0]
    return row === undefined ? null : projectCity(row)
  }
}
