import type { INestApplication } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import request from "supertest"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { OptionalClerkAuthGuard } from "../../src/auth/optional-clerk.guard.js"
import { ConsumerController } from "../../src/consumer/consumer.controller.js"
import { ConsumerService } from "../../src/consumer/consumer.service.js"
import { EventsRepository } from "../../src/data/events.repository.js"
import { ReferenceRepository } from "../../src/data/reference.repository.js"
import type { DbService } from "../../src/db/db.service.js"
import { createIntegrationDb } from "./db.js"
import { ensureCatalogSchema, truncateCatalog } from "./catalog.js"

let db: DbService
let app: INestApplication
const city = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
beforeAll(async () => {
  db = createIntegrationDb()
  await ensureCatalogSchema(db)
  const consumer = new ConsumerService(
    new EventsRepository(db),
    new ReferenceRepository(db),
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never
  )
  const module = await Test.createTestingModule({
    controllers: [ConsumerController],
    providers: [{ provide: ConsumerService, useValue: consumer }],
  })
    .overrideGuard(OptionalClerkAuthGuard)
    .useValue({ canActivate: () => true })
    .compile()
  app = module.createNestApplication()
  await app.init()
})
beforeEach(async () => {
  await truncateCatalog(db)
  await db.query(
    "INSERT INTO public.cities(id,name,slug,state,timezone,is_active) VALUES($1,'Lafayette','lafayette','LA','America/Chicago',true)",
    [city]
  )
  await db.query(
    "INSERT INTO public.tags(id,name,slug) VALUES('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','Outdoor','outdoor')"
  )
})
afterAll(async () => {
  await app?.close()
  await db?.onModuleDestroy()
})

describe("discovery through HTTP and PostgreSQL", () => {
  it("combines local custom dates, tags and radius identically across Explore and Map", async () => {
    await db.query(
      `INSERT INTO public.events(id,title,start_datetime,timezone,city_id,status,latitude,longitude,age_min,age_max,admission_cost_state,admission_cost_evidence)
      VALUES ('11111111-1111-4111-8111-111111111111','Outdoor storytime','2026-03-09T04:30:00Z','America/Chicago',$1,'published',30.22,-92.02,2,8,'free','Free admission'),
      ('22222222-2222-4222-8222-222222222222','Next local day','2026-03-09T05:00:00Z','America/Chicago',$1,'published',30.22,-92.02,2,8,'free','Free admission'),
      ('33333333-3333-4333-8333-333333333333','Too far','2026-03-09T04:30:00Z','America/Chicago',$1,'published',31,-92.02,2,8,'free','Free admission'),
      ('44444444-4444-4444-8444-444444444444','Draft','2026-03-09T04:30:00Z','America/Chicago',$1,'draft',30.22,-92.02,2,8,'free','Free admission')`,
      [city]
    )
    await db.query(
      "INSERT INTO public.event_tags(event_id,tag_id) SELECT id,'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'::uuid FROM public.events"
    )
    const query = {
      date_start: "2026-03-08",
      date_end: "2026-03-08",
      tags: "outdoor",
      lat: "30.22",
      lng: "-92.02",
      radius_km: "5",
      ages: "3,7",
      cost: "free",
    }
    const explore = await request(app.getHttpServer()).get("/v1/events").query(query).expect(200)
    const map = await request(app.getHttpServer()).get("/v1/events/map").query(query).expect(200)
    expect(explore.body.events.map((row: { id: string }) => row.id)).toEqual([
      "11111111-1111-4111-8111-111111111111",
    ])
    expect(map.body.events.map((row: { id: string }) => row.id)).toEqual([
      "11111111-1111-4111-8111-111111111111",
    ])
    expect(map.body.omitted_without_coordinates).toBe(0)
  })
  it("paginates all four legacy sorts without duplicates or losing timestamp precision", async () => {
    await db.query(
      `INSERT INTO public.events(id,title,start_datetime,timezone,city_id,status,price)
      SELECT ('00000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid, 'Event ' || n,
        '2035-01-01T12:00:00.123456Z'::timestamptz + make_interval(secs => n), 'America/Chicago', $1, 'published',
        CASE WHEN n % 5 = 0 THEN NULL ELSE n % 4 END FROM generate_series(1,53) n`,
      [city]
    )
    await db.query(
      `INSERT INTO public.ratings(user_id,event_id,score) SELECT '99999999-9999-4999-8999-999999999999',id,(right(id::text,2)::int % 5) + 1 FROM public.events`
    )
    await db.query(
      `INSERT INTO public.ratings(user_id,event_id,score) SELECT '88888888-8888-4888-8888-888888888888',id,3 FROM public.events WHERE right(id::text,2)::int % 3=0`
    )
    await db.query(
      `INSERT INTO public.ratings(user_id,event_id,score) SELECT '77777777-7777-4777-8777-777777777777',id,4 FROM public.events WHERE right(id::text,2)::int % 3=0`
    )
    await db.query(
      `DELETE FROM public.ratings WHERE event_id='00000000-0000-4000-8000-000000000015'`
    )
    for (const sort of ["soonest", "latest", "price-asc", "rating-desc"]) {
      const ids: string[] = []
      let cursor: string | null = null
      do {
        const response: request.Response = await request(app.getHttpServer())
          .get("/v1/events")
          .query({ range: "upcoming", sort, ...(cursor ? { cursor } : {}) })
          .expect(200)
        expect(response.body.events.length).toBeLessThanOrEqual(24)
        ids.push(...response.body.events.map((row: { id: string }) => row.id))
        cursor = response.body.next_cursor
        if (ids.length > 100) throw new Error("cursor did not progress")
      } while (cursor)
      const order =
        sort === "latest"
          ? "start_datetime DESC,id DESC"
          : sort === "price-asc"
            ? "price ASC NULLS LAST,start_datetime,id"
            : sort === "rating-desc"
              ? "avg_rating DESC,rating_count DESC,start_datetime,id"
              : "start_datetime,id"
      const expected = await db.query(
        `SELECT e.id, COALESCE(round(avg(r.score)::numeric,1),0) AS avg_rating,count(r.score) AS rating_count FROM public.events e LEFT JOIN public.ratings r ON r.event_id=e.id GROUP BY e.id ORDER BY ${order}`
      )
      expect(ids).toEqual(expected.map((row) => row.id))
      expect(new Set(ids).size).toBe(53)
    }
  })

  it("restores week, month and past ranges without changing the weekend window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-03-08T20:00:00Z"))
    try {
      await db.query(
        `INSERT INTO public.events(id,title,start_datetime,timezone,city_id,status)
        SELECT ('00000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid, 'Day ' || n, start::timestamptz,'America/Chicago',$1,'published'
        FROM (VALUES (1,'2026-03-07T18:00:00Z'),(2,'2026-03-08T22:00:00Z'),(3,'2026-03-10T18:00:00Z'),(4,'2026-04-07T18:00:00Z'),(5,'2026-04-08T18:00:00Z')) dates(n,start)`,
        [city]
      )
      for (const [range, expected] of [
        ["weekend", [2]],
        ["week", [2, 3]],
        ["month", [2, 3, 4]],
        ["past", [1]],
      ] as const) {
        for (const path of ["/v1/events", "/v1/events/map"]) {
          const response = await request(app.getHttpServer()).get(path).query({ range }).expect(200)
          if (path.endsWith("/map"))
            expect(response.body.omitted_without_coordinates).toBe(expected.length)
          else
            expect(response.body.events.map((row: { title: string }) => row.title)).toEqual(
              expected.map((n) => "Day " + n)
            )
        }
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it("caps Map at 200 coordinates and counts every coordinate exclusion before the cap", async () => {
    await db.query(
      `INSERT INTO public.events(id,title,start_datetime,timezone,city_id,status,latitude,longitude)
      SELECT ('00000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,'Map ' || n,'2035-01-01T12:00:00Z'::timestamptz + make_interval(secs=>n),'America/Chicago',$1,'published',CASE WHEN n>201 THEN NULL ELSE 30.22 END,-92.02 FROM generate_series(1,204) n`,
      [city]
    )
    const response = await request(app.getHttpServer())
      .get("/v1/events/map")
      .query({ range: "upcoming", sort: "latest" })
      .expect(200)
    expect(response.body.events).toHaveLength(200)
    expect(response.body.events[0].title).toBe("Map 201")
    expect(response.body.events.at(-1).title).toBe("Map 2")
    expect(response.body.omitted_without_coordinates).toBe(3)
  })
  it("rejects malformed controls and sort-mismatched cursors through HTTP", async () => {
    for (const query of [
      { date_start: "2026-02-30" },
      { date_start: "2026-03-09", date_end: "2026-03-08" },
      { range: "today", date_start: "2026-03-08" },
      { lat: "30", lng: "-92" },
      { lat: "91", lng: "-92", radius_km: "10" },
      { lat: "30", lng: "-92", radius_km: "51" },
      { tags: "outdoor,outdoor" },
      { sort: "unknown" },
      { viewer_id: city },
    ]) {
      for (const path of ["/v1/events", "/v1/events/map"])
        await request(app.getHttpServer()).get(path).query(query).expect(400)
    }
    await db.query(
      `INSERT INTO public.events(title,start_datetime,city_id,status) SELECT 'Page ' || n,'2035-01-01T12:00:00.123456Z'::timestamptz+make_interval(secs=>n),$1,'published' FROM generate_series(1,25) n`,
      [city]
    )
    const page = await request(app.getHttpServer())
      .get("/v1/events")
      .query({ range: "upcoming", sort: "latest" })
      .expect(200)
    await request(app.getHttpServer())
      .get("/v1/events")
      .query({ range: "upcoming", sort: "soonest", cursor: page.body.next_cursor })
      .expect(400)
  })
})
