import { describe, expect, it, vi } from "vitest"

import type { DbService } from "../db/db.service.js"
import { decodeEventCursor } from "./cursor.js"
import { EventsRepository } from "./events.repository.js"
import type { EventRow, TagRow } from "./public-event.js"

const EVENT_A: EventRow = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  title: "Storytime",
  description: null,
  start_datetime: "2026-08-16T15:00:00+00:00",
  end_datetime: null,
  timezone: "America/Chicago",
  venue_name: null,
  address: null,
  city_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  latitude: null,
  longitude: null,
  age_min: null,
  age_max: null,
  price: 0,
  is_free: true,
  is_featured: false,
  is_outdoor: null,
  images: [],
  source_url: null,
}

const EVENT_B: EventRow = {
  ...EVENT_A,
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  title: "Farmers Market",
  start_datetime: "2026-08-16T16:00:00+00:00",
}

function makeRepo(eventPages: EventRow[], tags: TagRow[] = []) {
  const query = vi.fn<(text: string, params?: unknown[]) => Promise<EventRow[] | TagRow[]>>(
    async (text) => {
      if (text.includes("SELECT et.event_id")) return tags
      return eventPages
    }
  )
  return { repo: new EventsRepository({ query } as unknown as DbService), query }
}

describe("EventsRepository", () => {
  it("lists published events and hydrates tags", async () => {
    const { repo, query } = makeRepo(
      [EVENT_A],
      [
        {
          event_id: EVENT_A.id,
          id: "tttttttt-tttt-4ttt-8ttt-tttttttttttt",
          name: "Free",
          slug: "free",
          color: "#abc",
        },
      ]
    )
    const result = await repo.listPublished({ limit: 20 })
    expect(query.mock.calls[0]?.[0]).toContain("e.status = 'published'")
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.tags).toEqual([
      { id: "tttttttt-tttt-4ttt-8ttt-tttttttttttt", name: "Free", slug: "free", color: "#abc" },
    ])
    expect(result.nextCursor).toBeNull()
  })

  it("returns a keyset cursor when an extra row was fetched", async () => {
    const { repo } = makeRepo([EVENT_A, EVENT_B])
    const result = await repo.listPublished({ limit: 1 })
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.id).toBe(EVENT_A.id)
    expect(decodeEventCursor(result.nextCursor ?? "")).toEqual({
      afterStart: EVENT_A.start_datetime,
      afterId: EVENT_A.id,
    })
  })

  it("escapes keyword metacharacters before the ILIKE bind", async () => {
    const { repo, query } = makeRepo([])
    await repo.listPublished({ limit: 20, keyword: "100%_off" })
    expect(query.mock.calls[0]?.[1]?.[4]).toBe("100\\%\\_off")
  })

  it("findPublishedById returns null when the row is missing or unpublished", async () => {
    const { repo } = makeRepo([])
    expect(await repo.findPublishedById(EVENT_A.id)).toBeNull()
  })
})
