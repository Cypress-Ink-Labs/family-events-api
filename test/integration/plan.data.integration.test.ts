import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { PlanRepository } from "../../src/data/plan.repository.js"
import type { DbService } from "../../src/db/db.service.js"
import { ensureCatalogSchema, truncateCatalog } from "./catalog.js"
import { createIntegrationDb } from "./db.js"

const CITY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const OTHER_CITY = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const USER = "99999999-9999-4999-8999-999999999999"

describe("U26 plan_events_for_user_range (integration, real RPC)", () => {
  let db: DbService
  let plan: PlanRepository

  beforeAll(async () => {
    db = createIntegrationDb()
    await ensureCatalogSchema(db)
    plan = new PlanRepository(db)
  })

  beforeEach(async () => {
    await truncateCatalog(db)
    await db.query(
      `INSERT INTO public.cities (id, name, slug, state, timezone, latitude, longitude, is_active) VALUES
       ($1, 'Lafayette', 'lafayette', 'LA', 'America/Chicago', 30.22, -92.02, true),
       ($2, 'Retired', 'retired', 'LA', 'America/Chicago', NULL, NULL, false)`,
      [CITY, OTHER_CITY]
    )
  })

  afterAll(async () => {
    await db.onModuleDestroy()
  })

  async function insertEvent(input: {
    title: string
    start: string
    status?: string
    cityId?: string
    venueName?: string
    address?: string
    isFree?: boolean
    price?: number | null
    images?: unknown
  }): Promise<string> {
    const id = randomUUID()
    await db.query(
      `INSERT INTO public.events (
         id, title, start_datetime, timezone, city_id, venue_name, address,
         is_free, price, images, status
       ) VALUES (
         $1, $2, $3, 'America/Chicago', $4, $5, $6, $7, $8, $9::jsonb, $10::public.event_status
       )`,
      [
        id,
        input.title,
        input.start,
        input.cityId ?? CITY,
        input.venueName ?? "Venue",
        input.address ?? "123 Test Street",
        input.isFree ?? false,
        input.price ?? 12.5,
        JSON.stringify(input.images ?? ["https://example.test/event.jpg"]),
        input.status ?? "published",
      ]
    )
    return id
  }

  it("returns hydrated display fields for a published event in the window", async () => {
    const id = await insertEvent({
      title: "CIL-035 Hydrated Event",
      start: "2041-06-21T15:00:00+00:00",
    })

    const rows = await plan.planForRange({
      userKey: USER,
      dateFrom: "2041-06-21T00:00:00+00:00",
      dateTo: "2041-06-22T00:00:00+00:00",
    })

    expect(rows).toEqual([
      expect.objectContaining({
        event_id: id,
        title: "CIL-035 Hydrated Event",
        venue_name: "Venue",
        address: "123 Test Street",
        is_free: false,
        price: "12.5",
        city_id: CITY,
        images: ["https://example.test/event.jpg"],
      }),
    ])
    expect(rows[0]?.score).toEqual(expect.any(String))
  })

  it("uses a half-open date window and ignores drafts", async () => {
    const included = await insertEvent({
      title: "Just inside",
      start: "2041-06-21T23:59:59+00:00",
    })
    await insertEvent({
      title: "At upper bound",
      start: "2041-06-22T00:00:00+00:00",
    })
    await insertEvent({
      title: "Draft",
      start: "2041-06-21T15:00:00+00:00",
      status: "draft",
    })

    const rows = await plan.planForRange({
      userKey: USER,
      dateFrom: "2041-06-21T00:00:00+00:00",
      dateTo: "2041-06-22T00:00:00+00:00",
    })

    expect(rows.map((row) => row.event_id)).toEqual([included])
  })

  it("filters by city_ids when provided", async () => {
    const match = await insertEvent({
      title: "Here",
      start: "2041-06-21T15:00:00+00:00",
      cityId: CITY,
    })
    await insertEvent({
      title: "Elsewhere",
      start: "2041-06-21T16:00:00+00:00",
      cityId: OTHER_CITY,
    })

    const rows = await plan.planForRange({
      userKey: USER,
      dateFrom: "2041-06-21T00:00:00+00:00",
      dateTo: "2041-06-22T00:00:00+00:00",
      cityIds: [CITY],
    })

    expect(rows.map((row) => row.event_id)).toEqual([match])
  })
})
