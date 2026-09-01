import { Injectable } from "@nestjs/common"

import { CalendarRepository } from "../data/calendar.repository.js"
import { CommentsRepository } from "../data/comments.repository.js"
import { EventsRepository } from "../data/events.repository.js"
import { FavoritesRepository } from "../data/favorites.repository.js"
import { PlanRepository } from "../data/plan.repository.js"
import { RatingsRepository } from "../data/ratings.repository.js"
import { ReferenceRepository } from "../data/reference.repository.js"
import type {
  CalendarEvent,
  City,
  EnrichedEvent,
  EventComment,
  PlannedEvent,
  PublicEventComment,
  SimilarEvent,
  Tag,
} from "../data/types.js"
import { zonedDayStartUtc } from "../pipeline/zoned-time.js"
import { encodeCursor } from "./cursor.js"
import type { ExploreQuery, PlanQuery } from "./consumer.query.js"
import { WeatherService } from "./weather.service.js"

const PLAN_LIMIT = 5
const DETAIL_SIMILAR_LIMIT = 4
const MAP_LIMIT = 200

// Consumers render in this zone when an event/city has none; the app's
// src/lib/dates.ts uses the same default.
const DEFAULT_PLAN_TIMEZONE = "America/Chicago"

export interface EventsPage {
  events: EnrichedEvent[]
  next_cursor: string | null
}

export interface PlanPage {
  available: boolean
  planned: PlannedEvent[]
}

export interface EventDetail {
  event: EnrichedEvent | null
  similar: SimilarEvent[]
  comments: PublicEventComment[]
  my_rating: number | null
  signed_in: boolean
}

export interface MapEvent {
  id: string
  title: string
  latitude: number
  longitude: number
  start_datetime: string
  venue_name: string | null
  is_free: boolean
}

function toPublicEventComment(comment: EventComment): PublicEventComment {
  return {
    id: comment.id,
    body: comment.body,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    display_name: comment.display_name,
    avatar_url: comment.avatar_url,
  }
}

@Injectable()
export class ConsumerService {
  constructor(
    private readonly eventsRepository: EventsRepository,
    private readonly referenceRepository: ReferenceRepository,
    private readonly planRepository: PlanRepository,
    private readonly weather: WeatherService,
    private readonly favorites: FavoritesRepository,
    private readonly calendar: CalendarRepository,
    private readonly ratings: RatingsRepository,
    private readonly comments: CommentsRepository
  ) {}

  listCities(): Promise<City[]> {
    return this.referenceRepository.listCities()
  }

  listTags(): Promise<Tag[]> {
    return this.referenceRepository.listTags()
  }

  async listEvents(input: ExploreQuery, userKey: string | null): Promise<EventsPage> {
    const usesSearch = input.keyword !== null || input.isFree !== null || input.kidAge !== null
    // Probe one row past the limit so next_cursor is emitted only when a next
    // page actually exists (an exactly-full last page must not advertise an
    // empty one). Same pattern as the legacy events-api edge function.
    const probeLimit = input.limit + 1
    let events: EnrichedEvent[]
    let hasMore: boolean

    if (usesSearch) {
      const hits = await this.eventsRepository.searchEvents({
        keyword: input.keyword,
        cityId: input.cityId,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        isFree: input.isFree,
        ageMin: input.kidAge,
        ageMax: input.kidAge,
        limit: probeLimit,
        after: input.after,
      })
      hasMore = hits.length > input.limit
      const pageHits = hasMore ? hits.slice(0, input.limit) : hits
      events =
        pageHits.length === 0
          ? []
          : await this.eventsRepository.listEvents({
              eventIds: pageHits.map((hit) => hit.id),
              userKey,
              limit: input.limit,
            })
      const order = new Map(pageHits.map((hit, index) => [hit.id, index]))
      events.sort(
        (left, right) =>
          (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(right.id) ?? Number.MAX_SAFE_INTEGER)
      )
    } else {
      events = await this.eventsRepository.listEvents({
        cityId: input.cityId,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        userKey,
        limit: probeLimit,
        after: input.after,
      })
      hasMore = events.length > input.limit
      if (hasMore) {
        events = events.slice(0, input.limit)
      }
    }

    const last = events.at(-1)
    return {
      events,
      next_cursor:
        hasMore && last !== undefined
          ? encodeCursor({ startDatetime: last.start_datetime, id: last.id })
          : null,
    }
  }

  async getEvent(id: string, userKey: string | null): Promise<EnrichedEvent | null> {
    const rows = await this.eventsRepository.listEvents({
      eventIds: [id],
      userKey,
      limit: 1,
    })
    return rows[0] ?? null
  }

  async getEventDetail(id: string, userKey: string | null): Promise<EventDetail> {
    const events = await this.eventsRepository.listEvents({ eventIds: [id], userKey, limit: 1 })
    const event = events[0]
    if (event === undefined) {
      return {
        event: null,
        similar: [],
        comments: [],
        my_rating: null,
        signed_in: userKey !== null,
      }
    }
    const [similar, comments, rating] = await Promise.all([
      this.eventsRepository.findSimilarEventsById(id, { limit: DETAIL_SIMILAR_LIMIT }),
      this.comments.listEventComments(id),
      userKey === null ? Promise.resolve(null) : this.ratings.getUserEventRating(userKey, id),
    ])
    return {
      event,
      similar,
      comments: comments.map(toPublicEventComment),
      my_rating: rating?.score ?? null,
      signed_in: userKey !== null,
    }
  }

  async listMapEvents(cityId: string | null): Promise<MapEvent[]> {
    const events = await this.eventsRepository.listMapEvents({ cityId, limit: MAP_LIMIT })
    const mapped: MapEvent[] = []
    for (const event of events) {
      if (event.latitude === null || event.longitude === null) continue
      const latitude = Number(event.latitude)
      const longitude = Number(event.longitude)
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue
      mapped.push({
        id: event.id,
        title: event.title,
        latitude,
        longitude,
        start_datetime: event.start_datetime,
        venue_name: event.venue_name,
        is_free: event.is_free,
      })
    }
    return mapped
  }

  async listFavoriteEvents(userKey: string): Promise<EnrichedEvent[]> {
    const favorites = await this.favorites.listFavorites(userKey)
    if (favorites.length === 0) return []
    return this.eventsRepository.listEvents({
      eventIds: favorites.map((favorite) => favorite.event_id),
      userKey,
      limit: favorites.length,
    })
  }

  listCalendarEvents(userKey: string): Promise<CalendarEvent[]> {
    return this.calendar.listCalendarEvents(userKey)
  }

  async planForToday(input: PlanQuery, userKey: string): Promise<PlanPage> {
    const now = new Date()
    const { lat, lng, weatherFit, timezone } = await this.resolvePlanContext(input.cityId)
    const planned = await this.planRepository.planForRange({
      userKey,
      dateFrom: zonedDayStartUtc(now, timezone, 0).toISOString(),
      dateTo: zonedDayStartUtc(now, timezone, 1).toISOString(),
      cityIds: input.cityId === null ? null : [input.cityId],
      lat,
      lng,
      kidAge: input.kidAge,
      weatherFit,
      limit: PLAN_LIMIT,
    })
    return { available: true, planned }
  }

  private async resolvePlanContext(cityId: string | null): Promise<{
    lat: number | null
    lng: number | null
    weatherFit: string
    timezone: string
  }> {
    if (cityId === null) {
      return { lat: null, lng: null, weatherFit: "neutral", timezone: DEFAULT_PLAN_TIMEZONE }
    }
    const cities = await this.referenceRepository.listCities()
    const city = cities.find((row) => row.id === cityId)
    const lat = parseCoord(city?.latitude ?? null)
    const lng = parseCoord(city?.longitude ?? null)
    const weatherFit =
      lat === null || lng === null ? "neutral" : (await this.weather.snapshot(lat, lng)).weatherFit
    return { lat, lng, weatherFit, timezone: city?.timezone ?? DEFAULT_PLAN_TIMEZONE }
  }
}

function parseCoord(value: string | null): number | null {
  if (value === null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
