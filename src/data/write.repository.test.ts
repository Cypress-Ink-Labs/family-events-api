import { describe, expect, it, vi } from "vitest"

import type { DbService } from "../db/db.service.js"
import { CalendarRepository } from "./calendar.repository.js"
import { CommentsRepository } from "./comments.repository.js"
import { FavoritesRepository } from "./favorites.repository.js"
import { PreferredCitiesRepository } from "./preferred-cities.repository.js"
import { RatingsRepository } from "./ratings.repository.js"
import { SubmissionsRepository } from "./submissions.repository.js"

function makeDb() {
  const query = vi.fn<(text: string, params?: unknown[]) => Promise<unknown[]>>(async () => [])
  return { db: { query } as unknown as DbService, query }
}

function makeTxDb(responses: unknown[][] = []) {
  const query = vi.fn(async () => {
    const rows = responses.shift() ?? []
    return { rows }
  })
  const withTransaction = vi.fn(async (fn: (client: { query: typeof query }) => unknown) =>
    fn({ query })
  )
  return {
    db: { query: vi.fn(), withTransaction } as unknown as DbService,
    query,
  }
}

describe("binding order (sentinel values)", () => {
  it("addFavorite binds user then event", async () => {
    const { db, query } = makeDb()
    await new FavoritesRepository(db).addFavorite("user", "event")
    expect(query.mock.calls[0]?.[1]).toEqual(["user", "event"])
  })

  it("addToCalendar binds user, event, then notes", async () => {
    const { db, query } = makeDb()
    await new CalendarRepository(db).addToCalendar("user", "event", "notes")
    expect(query.mock.calls[0]?.[1]).toEqual(["user", "event", "notes"])
  })

  it("upsertEventRating binds user, event, then score", async () => {
    const { db, query } = makeDb()
    query.mockResolvedValueOnce([
      { id: "r", user_id: "user", event_id: "event", score: 3, created_at: "t" },
    ])
    await new RatingsRepository(db).upsertEventRating("user", "event", 3)
    expect(query.mock.calls[0]?.[1]).toEqual(["user", "event", 3])
  })

  it("addEventComment binds user, event, then trimmed body", async () => {
    const { db, query } = makeDb()
    query.mockResolvedValueOnce([{ id: "c1" }])
    await new CommentsRepository(db).addEventComment("user", "event", "  hi  ")
    expect(query.mock.calls[0]?.[1]).toEqual(["user", "event", "hi"])
  })

  it("deleteOwnComment binds comment id then user (SQL column order)", async () => {
    const { db, query } = makeDb()
    await new CommentsRepository(db).deleteOwnComment("user", "comment")
    expect(query.mock.calls[0]?.[1]).toEqual(["comment", "user"])
  })

  it("submitCommunityEvent binds insert columns after the rate-limit key", async () => {
    const { db, query } = makeTxDb([[{ count: 0 }], [{ id: "e1" }]])
    await new SubmissionsRepository(db).submitCommunityEvent("user", {
      title: "Picnic",
      description: "desc",
      startDatetime: "start",
      endDatetime: "end",
      venueName: "venue",
      address: "addr",
      cityId: "city",
      ageMin: 1,
      ageMax: 2,
      isFree: false,
      price: 5,
    })
    expect(query.mock.calls[0]?.[1]).toEqual(["user"])
    expect(query.mock.calls[1]?.[1]).toEqual([
      "Picnic",
      "desc",
      "start",
      "end",
      "venue",
      "addr",
      "city",
      1,
      2,
      false,
      5,
      "user",
    ])
  })

  it("setPreferredCities demotes then upserts with user / primary / set order", async () => {
    const { db, query } = makeTxDb()
    await new PreferredCitiesRepository(db).setPreferredCities("user", ["b", "a", "b"], "a")
    expect(query.mock.calls.map((call) => call[1])).toEqual([
      ["user", ["b", "a"]],
      ["user", "a"],
      ["user", "a", ["b", "a"]],
      ["a", "user"],
    ])
  })
})
