import { ConfigService } from "@nestjs/config"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { CitiesRepository } from "../../src/data/cities.repository.js"
import { DbService } from "../../src/db/db.service.js"
import { ensureCatalogSchema, truncateCatalog } from "./catalog.js"

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres"

const ACTIVE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const INACTIVE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"

describe("CitiesRepository (integration)", () => {
  let db: DbService
  let cities: CitiesRepository

  beforeAll(async () => {
    db = new DbService(new ConfigService({ DATABASE_URL }) as unknown as ConfigService<never, true>)
    await ensureCatalogSchema(db)
    cities = new CitiesRepository(db)
  })

  beforeEach(async () => {
    await truncateCatalog(db)
    await db.query(
      `INSERT INTO public.cities (id, name, slug, state, timezone, is_active) VALUES
       ($1, 'Lafayette', 'lafayette', 'LA', 'America/Chicago', true),
       ($2, 'Retired', 'retired', 'LA', 'America/Chicago', false)`,
      [ACTIVE, INACTIVE]
    )
  })

  afterAll(async () => {
    await db.onModuleDestroy()
  })

  it("lists only active cities", async () => {
    const listed = await cities.listActive()
    expect(listed.map((city) => city.slug)).toEqual(["lafayette"])
    expect(listed[0]?.isActive).toBe(true)
  })

  it("finds a city by id even when inactive (admin/internal lookup)", async () => {
    const city = await cities.findById(INACTIVE)
    expect(city?.slug).toBe("retired")
    expect(city?.isActive).toBe(false)
  })
})
