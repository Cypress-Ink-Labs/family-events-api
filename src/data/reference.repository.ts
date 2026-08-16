import { Injectable } from "@nestjs/common"

import { DbService } from "../db/db.service.js"
import type { City } from "./types.js"

// Reference data (U23): port of family-events-app src/server/reference.ts.

const CITIES_SQL = `
SELECT id::text, name, state, slug, timezone, latitude, longitude
FROM public.cities
WHERE is_active = true
ORDER BY name ASC
`

@Injectable()
export class ReferenceRepository {
  constructor(private readonly db: DbService) {}

  async listCities(): Promise<City[]> {
    return this.db.query<City>(CITIES_SQL)
  }
}
