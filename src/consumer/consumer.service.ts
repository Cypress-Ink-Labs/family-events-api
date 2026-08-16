import { Injectable } from "@nestjs/common"

import { EventsRepository } from "../data/events.repository.js"
import { PlanRepository } from "../data/plan.repository.js"
import { ReferenceRepository } from "../data/reference.repository.js"
import type { City, EnrichedEvent, PlannedEvent, Tag } from "../data/types.js"
import { encodeCursor } from "./cursor.js"
import type { ExploreQuery, PlanQuery } from "./consumer.query.js"
import { WeatherService } from "./weather.service.js"

const PLAN_WINDOW_MS = 86_400_000
const PLAN_LIMIT = 5

export interface EventsPage {
  events: EnrichedEvent[]
  next_cursor: string | null
}

export interface PlanPage {
  available: boolean
  planned: PlannedEvent[]
}

@Injectable()
export class ConsumerService {
  constructor(
    private readonly eventsRepository: EventsRepository,
    private readonly referenceRepository: ReferenceRepository,
    private readonly planRepository: PlanRepository,
    private readonly weather: WeatherService
  ) {}

  listCities(): Promise<City[]> {
    return this.referenceRepository.listCities()
  }

  listTags(): Promise<Tag[]> {
    return this.referenceRepository.listTags()
  }

  async listEvents(input: ExploreQuery, userKey: string | null): Promise<EventsPage> {
    const usesSearch = input.keyword !== null || input.isFree !== null || input.kidAge !== null
    let events: EnrichedEvent[]

    if (usesSearch) {
      const hits = await this.eventsRepository.searchEvents({
        keyword: input.keyword,
        cityId: input.cityId,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        isFree: input.isFree,
        ageMin: input.kidAge,
        ageMax: input.kidAge,
        limit: input.limit,
        after: input.after,
      })
      events =
        hits.length === 0
          ? []
          : await this.eventsRepository.listEvents({
              eventIds: hits.map((hit) => hit.id),
              userKey,
              limit: input.limit,
            })
      const order = new Map(hits.map((hit, index) => [hit.id, index]))
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
        limit: input.limit,
        after: input.after,
      })
    }

    const last = events.at(-1)
    return {
      events,
      next_cursor:
        events.length === input.limit && last !== undefined
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

  async planForToday(input: PlanQuery, userKey: string): Promise<PlanPage> {
    const from = new Date()
    const to = new Date(from.getTime() + PLAN_WINDOW_MS)
    const { lat, lng, weatherFit } = await this.resolvePlanWeather(input.cityId)
    const planned = await this.planRepository.planForRange({
      userKey,
      dateFrom: from.toISOString(),
      dateTo: to.toISOString(),
      cityIds: input.cityId === null ? null : [input.cityId],
      lat,
      lng,
      kidAge: input.kidAge,
      weatherFit,
      limit: PLAN_LIMIT,
    })
    return { available: true, planned }
  }

  private async resolvePlanWeather(cityId: string | null): Promise<{
    lat: number | null
    lng: number | null
    weatherFit: string
  }> {
    if (cityId === null) {
      return { lat: null, lng: null, weatherFit: "neutral" }
    }
    const cities = await this.referenceRepository.listCities()
    const city = cities.find((row) => row.id === cityId)
    const lat = parseCoord(city?.latitude ?? null)
    const lng = parseCoord(city?.longitude ?? null)
    if (lat === null || lng === null) {
      return { lat: null, lng: null, weatherFit: "neutral" }
    }
    const snapshot = await this.weather.snapshot(lat, lng)
    return { lat, lng, weatherFit: snapshot.weatherFit }
  }
}

function parseCoord(value: string | null): number | null {
  if (value === null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
