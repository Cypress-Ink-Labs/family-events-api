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
import type { ExploreQuery, MapQuery, PlanQuery } from "./consumer.query.js"
import { WeatherService } from "./weather.service.js"

const PLAN_LIMIT = 5
const DETAIL_SIMILAR_LIMIT = 4

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
  timezone: string | null
  venue_name: string | null
  is_free: boolean
  admission_cost_state: "free" | "paid" | "unknown"
  admission_amount: string | null
  age_match: "confirmed" | "unknown" | null
  family_needs: EnrichedEvent["family_needs"]
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
    // Probe one row past the limit so next_cursor is emitted only when a next
    // page actually exists (an exactly-full last page must not advertise an
    // empty one). Same pattern as the legacy events-api edge function.
    const probeLimit = input.limit + 1
    let events = await this.eventsRepository.discoverEvents({
      range: input.range,
      now: new Date().toISOString(),
      cityId: input.cityId,
      keyword: input.keyword,
      cost: input.cost ?? "any",
      isFree: input.isFree,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      ages: input.ages,
      ageMode: input.ageMode,
      includeUnknownAge: input.includeUnknownAge,
      ...(input.familyNeeds
        ? {
            familyNeeds: input.familyNeeds,
            includeUnknownFamilyNeeds: input.includeUnknownFamilyNeeds ?? false,
          }
        : {}),
      userKey,
      limit: probeLimit,
      after: input.after,
    })
    const hasMore = events.length > input.limit
    if (hasMore) {
      events = events.slice(0, input.limit)
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

  async listMapEvents(input: MapQuery): Promise<{
    events: MapEvent[]
    omitted_without_coordinates: number
  }> {
    const result = await this.eventsRepository.listMapEvents({
      cityId: input.cityId,
      range: input.range,
      now: new Date().toISOString(),
      ages: input.ages,
      ageMode: input.ageMode,
      includeUnknownAge: input.includeUnknownAge,
      ...(input.familyNeeds
        ? {
            familyNeeds: input.familyNeeds,
            includeUnknownFamilyNeeds: input.includeUnknownFamilyNeeds ?? false,
          }
        : {}),
      cost: input.cost ?? "any",
    })
    const mapped: MapEvent[] = []
    for (const event of result.events) {
      const latitude = Number(event.latitude)
      const longitude = Number(event.longitude)
      mapped.push({
        id: event.id,
        title: event.title,
        latitude,
        longitude,
        start_datetime: event.start_datetime,
        timezone: event.timezone,
        venue_name: event.venue_name,
        is_free: event.is_free,
        admission_cost_state: event.admission_cost_state,
        admission_amount: event.admission_amount,
        age_match: event.age_match,
        family_needs: event.family_needs,
      })
    }
    return {
      events: mapped,
      omitted_without_coordinates: result.omittedWithoutCoordinates,
    }
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
    return {
      available: true,
      planned: planned.map(
        ({
          distance_score: _distanceScore,
          weather_score: _weatherScore,
          age_score: _ageScore,
          history_affinity: _historyAffinity,
          family_fit_score: _familyFitScore,
          timing_score: _timingScore,
          novelty_score: _noveltyScore,
          budget_score: _budgetScore,
          distance_km: _distanceKm,
          ...event
        }) => event
      ),
    }
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
