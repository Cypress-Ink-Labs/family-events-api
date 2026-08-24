import { afterEach, describe, expect, it, vi } from "vitest"

import type { CalendarRepository } from "../data/calendar.repository.js"
import type { CommentsRepository } from "../data/comments.repository.js"
import type { EventsRepository } from "../data/events.repository.js"
import type { FavoritesRepository } from "../data/favorites.repository.js"
import type { PlanRepository } from "../data/plan.repository.js"
import type { RatingsRepository } from "../data/ratings.repository.js"
import type { ReferenceRepository } from "../data/reference.repository.js"
import type { City, EnrichedEvent } from "../data/types.js"
import { ConsumerService } from "./consumer.service.js"
import type { WeatherService } from "./weather.service.js"

const CITY: City = {
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  name: "Lafayette",
  state: "LA",
  slug: "lafayette",
  timezone: "America/Chicago",
  latitude: "30.22",
  longitude: "-92.02",
}

function makeService(opts?: { cities?: City[]; weatherFit?: string }): {
  service: ConsumerService
  listEvents: ReturnType<typeof vi.fn>
  listMapEvents: ReturnType<typeof vi.fn>
  findSimilarEventsById: ReturnType<typeof vi.fn>
  listFavorites: ReturnType<typeof vi.fn>
  listCalendarEvents: ReturnType<typeof vi.fn>
  listEventComments: ReturnType<typeof vi.fn>
  getUserEventRating: ReturnType<typeof vi.fn>
  planForRange: ReturnType<typeof vi.fn>
  snapshot: ReturnType<typeof vi.fn>
} {
  const listEvents = vi.fn(async () => [])
  const listMapEvents = vi.fn(async () => [])
  const findSimilarEventsById = vi.fn(async () => [])
  const listFavorites = vi.fn(async () => [])
  const listCalendarEvents = vi.fn(async () => [])
  const listEventComments = vi.fn(async () => [])
  const getUserEventRating = vi.fn(async () => null)
  const planForRange = vi.fn(async () => [])
  const snapshot = vi.fn(async () => ({
    available: true,
    weatherFit: opts?.weatherFit ?? "outdoor",
    temperatureC: 21,
    condition: "Clear",
    observedAt: "2026-08-16T12:00:00.000Z",
  }))
  const service = new ConsumerService(
    { listEvents, listMapEvents, findSimilarEventsById } as unknown as EventsRepository,
    { listCities: async () => opts?.cities ?? [CITY] } as unknown as ReferenceRepository,
    { planForRange } as unknown as PlanRepository,
    { snapshot } as unknown as WeatherService,
    { listFavorites } as unknown as FavoritesRepository,
    { listCalendarEvents } as unknown as CalendarRepository,
    { getUserEventRating } as unknown as RatingsRepository,
    { listEventComments } as unknown as CommentsRepository
  )
  return {
    service,
    listEvents,
    listMapEvents,
    findSimilarEventsById,
    listFavorites,
    listCalendarEvents,
    listEventComments,
    getUserEventRating,
    planForRange,
    snapshot,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe("ConsumerService.planForToday", () => {
  it("uses the app's D+0..1 window, limit 5, and weatherFit neutral without a city", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-16T12:00:00.000Z"))
    const { service, planForRange, snapshot } = makeService()

    await expect(service.planForToday({ cityId: null, kidAge: null }, "user-1")).resolves.toEqual({
      available: true,
      planned: [],
    })

    expect(snapshot).not.toHaveBeenCalled()
    expect(planForRange).toHaveBeenCalledWith({
      userKey: "user-1",
      dateFrom: "2026-08-16T12:00:00.000Z",
      dateTo: "2026-08-17T12:00:00.000Z",
      cityIds: null,
      lat: null,
      lng: null,
      kidAge: null,
      weatherFit: "neutral",
      limit: 5,
    })
  })

  it("threads city coords and weatherFit when the city has coordinates", async () => {
    const { service, planForRange, snapshot } = makeService({ weatherFit: "indoor" })
    await service.planForToday({ cityId: CITY.id, kidAge: 6 }, "user-1")
    expect(snapshot).toHaveBeenCalledWith(30.22, -92.02)
    expect(planForRange.mock.calls[0]?.[0]).toMatchObject({
      cityIds: [CITY.id],
      lat: 30.22,
      lng: -92.02,
      kidAge: 6,
      weatherFit: "indoor",
    })
  })
})

describe("ConsumerService.getEventDetail", () => {
  const event = {
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    title: "Storytime",
  } as EnrichedEvent

  it("composes event, similar titles, approved comments, and the caller's rating", async () => {
    const { service, listEvents, findSimilarEventsById, listEventComments, getUserEventRating } =
      makeService()
    listEvents.mockResolvedValueOnce([event])
    findSimilarEventsById.mockResolvedValueOnce([{ event_id: "similar-1", title: "Puppets" }])
    listEventComments.mockResolvedValueOnce([
      {
        id: "comment-1",
        user_id: "private-user-id",
        event_id: event.id,
        body: "Fun",
        is_approved: true,
        is_flagged: false,
        created_at: "2026-08-16T16:00:00Z",
        updated_at: "2026-08-16T17:00:00Z",
        display_name: "A parent",
        avatar_url: null,
      },
    ])
    getUserEventRating.mockResolvedValueOnce({ score: 5 })

    await expect(service.getEventDetail(event.id, "user-1")).resolves.toEqual({
      event,
      similar: [{ event_id: "similar-1", title: "Puppets" }],
      comments: [
        {
          id: "comment-1",
          body: "Fun",
          created_at: "2026-08-16T16:00:00Z",
          updated_at: "2026-08-16T17:00:00Z",
          display_name: "A parent",
          avatar_url: null,
        },
      ],
      my_rating: 5,
      signed_in: true,
    })
    expect(listEvents).toHaveBeenCalledWith({ eventIds: [event.id], userKey: "user-1", limit: 1 })
    expect(findSimilarEventsById).toHaveBeenCalledWith(event.id, { limit: 4 })
    expect(listEventComments).toHaveBeenCalledWith(event.id)
    expect(getUserEventRating).toHaveBeenCalledWith("user-1", event.id)
  })

  it("does not hydrate related data when the published event is not visible", async () => {
    const { service, findSimilarEventsById, listEventComments, getUserEventRating } = makeService()

    await expect(service.getEventDetail(event.id, "user-1")).resolves.toEqual({
      event: null,
      similar: [],
      comments: [],
      my_rating: null,
      signed_in: true,
    })
    expect(findSimilarEventsById).not.toHaveBeenCalled()
    expect(listEventComments).not.toHaveBeenCalled()
    expect(getUserEventRating).not.toHaveBeenCalled()
  })
})

describe("ConsumerService.listMapEvents", () => {
  it("requests 200 coordinate-bearing events and returns only finite numeric coordinates", async () => {
    const { service, listMapEvents } = makeService()
    listMapEvents.mockResolvedValueOnce([
      {
        id: "event-1",
        title: "Mappable",
        latitude: "30.22",
        longitude: "-92.02",
        start_datetime: "2026-08-16T15:00:00+00:00",
        venue_name: "Library",
        is_free: true,
      },
      { id: "event-2", latitude: null, longitude: "-92.02" },
      { id: "event-3", latitude: "1e9999", longitude: "-92.02" },
    ])

    await expect(service.listMapEvents(CITY.id)).resolves.toEqual([
      {
        id: "event-1",
        title: "Mappable",
        latitude: 30.22,
        longitude: -92.02,
        start_datetime: "2026-08-16T15:00:00+00:00",
        venue_name: "Library",
        is_free: true,
      },
    ])
    expect(listMapEvents).toHaveBeenCalledWith({ cityId: CITY.id, limit: 200 })
  })
})

describe("ConsumerService.listFavoriteEvents", () => {
  it("hydrates only the caller's favorite ids with caller personalization", async () => {
    const { service, listFavorites, listEvents } = makeService()
    listFavorites.mockResolvedValueOnce([{ event_id: "event-2" }, { event_id: "event-1" }])
    listEvents.mockResolvedValueOnce([{ id: "event-1" }, { id: "event-2" }])

    await expect(service.listFavoriteEvents("user-1")).resolves.toEqual([
      { id: "event-1" },
      { id: "event-2" },
    ])
    expect(listFavorites).toHaveBeenCalledWith("user-1")
    expect(listEvents).toHaveBeenCalledWith({
      eventIds: ["event-2", "event-1"],
      userKey: "user-1",
      limit: 2,
    })
  })

  it("does not issue an event query when the caller has no favorites", async () => {
    const { service, listEvents } = makeService()
    await expect(service.listFavoriteEvents("user-1")).resolves.toEqual([])
    expect(listEvents).not.toHaveBeenCalled()
  })
})

describe("ConsumerService.listCalendarEvents", () => {
  it("delegates the owner-scoped calendar read with the mapped key", async () => {
    const { service, listCalendarEvents } = makeService()
    listCalendarEvents.mockResolvedValueOnce([{ event_id: "event-1", title: "Storytime" }])

    await expect(service.listCalendarEvents("user-1")).resolves.toEqual([
      { event_id: "event-1", title: "Storytime" },
    ])
    expect(listCalendarEvents).toHaveBeenCalledWith("user-1")
  })
})
