import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { CalendarRepository } from "../../src/data/calendar.repository.js"
import { CommentsRepository } from "../../src/data/comments.repository.js"
import { FavoritesRepository } from "../../src/data/favorites.repository.js"
import { PreferredCitiesRepository } from "../../src/data/preferred-cities.repository.js"
import { RatingsRepository } from "../../src/data/ratings.repository.js"
import {
  SubmissionLimitError,
  SubmissionsRepository,
} from "../../src/data/submissions.repository.js"
import type { DbService } from "../../src/db/db.service.js"
import { createIntegrationDb } from "./db.js"
import { ensureCatalogSchema, truncateCatalog } from "./catalog.js"

const CITY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const OTHER_CITY = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const USER_A = "99999999-9999-4999-8999-999999999999"
const USER_B = "88888888-8888-4888-8888-888888888888"

describe("U23 write-side data layer", () => {
  let db: DbService
  let favorites: FavoritesRepository
  let calendar: CalendarRepository
  let ratings: RatingsRepository
  let comments: CommentsRepository
  let submissions: SubmissionsRepository
  let preferredCities: PreferredCitiesRepository

  beforeAll(async () => {
    db = createIntegrationDb()
    await ensureCatalogSchema(db)
    favorites = new FavoritesRepository(db)
    calendar = new CalendarRepository(db)
    ratings = new RatingsRepository(db)
    comments = new CommentsRepository(db)
    submissions = new SubmissionsRepository(db)
    preferredCities = new PreferredCitiesRepository(db)
  })

  beforeEach(async () => {
    await truncateCatalog(db)
    await db.query(
      `INSERT INTO public.cities (id, name, slug, state, timezone, latitude, longitude, is_active) VALUES
       ($1, 'Lafayette', 'lafayette', 'LA', 'America/Chicago', 30.22, -92.02, true),
       ($2, 'Baton Rouge', 'baton-rouge', 'LA', 'America/Chicago', 30.45, -91.19, true)`,
      [CITY, OTHER_CITY]
    )
    await db.query(
      `INSERT INTO public.user_profiles (id, email, display_name, avatar_url) VALUES
       ($1, 'a@test.example', 'Ada', 'https://example.test/ada.png'),
       ($2, 'b@test.example', 'Bea', NULL)`,
      [USER_A, USER_B]
    )
  })

  afterAll(async () => {
    await db.onModuleDestroy()
  })

  async function insertEvent(title = "Storytime"): Promise<string> {
    const id = randomUUID()
    await db.query(
      `INSERT INTO public.events (id, title, start_datetime, timezone, city_id, is_free, status)
       VALUES ($1, $2, '2026-08-16T15:00:00+00:00', 'America/Chicago', $3, true, 'published')`,
      [id, title, CITY]
    )
    return id
  }

  describe("favorites", () => {
    it("toggles idempotently and isolates owners", async () => {
      const eventId = await insertEvent()
      await favorites.addFavorite(USER_A, eventId)
      await favorites.addFavorite(USER_A, eventId)
      const mine = await favorites.listFavorites(USER_A)
      expect(mine).toHaveLength(1)
      expect(mine[0]).toMatchObject({ user_id: USER_A, event_id: eventId })
      expect(typeof mine[0]!.created_at).toBe("string")
      expect(await favorites.listFavorites(USER_B)).toEqual([])

      await favorites.removeFavorite(USER_B, eventId)
      expect(await favorites.listFavorites(USER_A)).toHaveLength(1)
      await favorites.removeFavorite(USER_A, eventId)
      expect(await favorites.listFavorites(USER_A)).toEqual([])
    })
  })

  describe("calendar", () => {
    it("adds, lists owner-scoped rows, and removes", async () => {
      const eventId = await insertEvent("Storytime Splash")
      await calendar.addToCalendar(USER_A, eventId, "bring towels")
      await calendar.addToCalendar(USER_A, eventId)
      const mine = await calendar.listCalendarEvents(USER_A)
      expect(mine).toHaveLength(1)
      expect(mine[0]).toMatchObject({
        event_id: eventId,
        notes: "bring towels",
        title: "Storytime Splash",
        city_id: CITY,
        is_free: true,
      })
      expect(typeof mine[0]!.added_at).toBe("string")
      expect(await calendar.listCalendarEvents(USER_B)).toEqual([])

      await calendar.removeFromCalendar(USER_B, eventId)
      expect(await calendar.listCalendarEvents(USER_A)).toHaveLength(1)
      await calendar.removeFromCalendar(USER_A, eventId)
      expect(await calendar.listCalendarEvents(USER_A)).toEqual([])
    })
  })

  describe("ratings", () => {
    it("upserts one score per (user, event) in 1-5", async () => {
      const eventId = await insertEvent()
      await ratings.upsertEventRating(USER_A, eventId, 4)
      const updated = await ratings.upsertEventRating(USER_A, eventId, 5)
      expect(updated.score).toBe(5)
      expect(updated.user_id).toBe(USER_A)
      expect(updated.event_id).toBe(eventId)

      expect((await ratings.getUserEventRating(USER_A, eventId))?.score).toBe(5)
      expect(await ratings.getUserEventRating(USER_B, eventId)).toBeNull()
    })

    it("rejects out-of-range scores", async () => {
      const eventId = await insertEvent()
      await expect(ratings.upsertEventRating(USER_A, eventId, 6)).rejects.toThrow(
        "integer from 1 to 5"
      )
      await expect(ratings.upsertEventRating(USER_A, eventId, 0)).rejects.toThrow(
        "integer from 1 to 5"
      )
    })
  })

  describe("comments", () => {
    it("inserts, lists join fields, and deletes only the owner's row", async () => {
      const eventId = await insertEvent()
      const { id } = await comments.addEventComment(USER_A, eventId, "So fun!")
      const listed = await comments.listEventComments(eventId)
      expect(listed).toHaveLength(1)
      expect(listed[0]).toMatchObject({
        id,
        user_id: USER_A,
        event_id: eventId,
        body: "So fun!",
        is_approved: true,
        is_flagged: false,
        display_name: "Ada",
        avatar_url: "https://example.test/ada.png",
      })

      expect(await comments.deleteOwnComment(USER_B, id)).toBe(false)
      expect((await comments.listEventComments(eventId)).map((row) => row.id)).toContain(id)
      expect(await comments.deleteOwnComment(USER_A, id)).toBe(true)
      expect(await comments.listEventComments(eventId)).toEqual([])
    })

    it("rejects empty bodies", async () => {
      const eventId = await insertEvent()
      await expect(comments.addEventComment(USER_A, eventId, "  ")).rejects.toThrow(
        "Comment body is required"
      )
    })
  })

  describe("submissions", () => {
    it("inserts draft community rows in the moderation state the pipeline expects", async () => {
      const { id } = await submissions.submitCommunityEvent(USER_A, {
        title: "Neighborhood Picnic",
        startDatetime: "2026-08-19T15:00:00+00:00",
        cityId: CITY,
        description: "Bring a blanket",
      })
      const [row] = await db.query<{
        status: string
        source_name: string
        submitted_by: string
        ai_confidence: string
        llm_review_status: string
        title: string
        description: string
      }>(
        `SELECT status, source_name, submitted_by::text, ai_confidence::text,
                llm_review_status::text, title, description
         FROM public.events WHERE id = $1`,
        [id]
      )
      expect(row).toMatchObject({
        status: "draft",
        source_name: "community",
        submitted_by: USER_A,
        llm_review_status: "not_required",
        title: "Neighborhood Picnic",
        description: "Bring a blanket",
      })
      expect(Number(row!.ai_confidence)).toBe(0)
    })

    it("rejects a sixth community submit inside 24h", async () => {
      const submit = (n: number) =>
        submissions.submitCommunityEvent(USER_B, {
          title: `Rate Limit ${n}`,
          startDatetime: "2026-08-17T15:00:00+00:00",
          cityId: CITY,
        })
      for (let n = 1; n <= 5; n++) await submit(n)
      await expect(submit(6)).rejects.toBeInstanceOf(SubmissionLimitError)
    })

    it("rejects missing required fields without writing", async () => {
      await expect(
        submissions.submitCommunityEvent(USER_A, {
          title: "   ",
          startDatetime: "2026-08-17T15:00:00+00:00",
          cityId: CITY,
        })
      ).rejects.toThrow("Title is required")
      const counts = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM public.events WHERE submitted_by = $1",
        [USER_A]
      )
      expect(counts[0]?.n).toBe(0)
    })
  })

  describe("preferred-cities", () => {
    it("sets the city set, marks the primary, and mirrors the profile column", async () => {
      await preferredCities.setPreferredCities(USER_A, [CITY, OTHER_CITY], CITY)
      const rows = await preferredCities.listPreferredCities(USER_A)
      expect(rows).toHaveLength(2)
      expect(rows.find((row) => row.city_id === CITY)?.is_primary).toBe(true)
      expect(rows.find((row) => row.city_id === OTHER_CITY)?.is_primary).toBe(false)

      const [profile] = await db.query<{ city_preference_id: string }>(
        "SELECT city_preference_id::text FROM public.user_profiles WHERE id = $1",
        [USER_A]
      )
      expect(profile?.city_preference_id).toBe(CITY)
    })

    it("flips the primary by demoting first, regardless of array order", async () => {
      await preferredCities.setPreferredCities(USER_A, [CITY, OTHER_CITY], OTHER_CITY)
      await preferredCities.setPreferredCities(USER_A, [CITY, OTHER_CITY], CITY)
      const rows = await preferredCities.listPreferredCities(USER_A)
      expect(rows.filter((row) => row.is_primary).map((row) => row.city_id)).toEqual([CITY])
    })

    it("drops deselected cities and validates inputs", async () => {
      await preferredCities.setPreferredCities(USER_A, [CITY, OTHER_CITY], CITY)
      await preferredCities.setPreferredCities(USER_A, [OTHER_CITY], OTHER_CITY)
      expect((await preferredCities.listPreferredCities(USER_A)).map((row) => row.city_id)).toEqual(
        [OTHER_CITY]
      )
      await expect(preferredCities.setPreferredCities(USER_A, [], CITY)).rejects.toThrow(
        "non-empty"
      )
      await expect(preferredCities.setPreferredCities(USER_A, [CITY], OTHER_CITY)).rejects.toThrow(
        "must be one of"
      )
    })
  })
})
