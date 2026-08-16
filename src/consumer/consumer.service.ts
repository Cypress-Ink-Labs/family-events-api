import { Injectable } from "@nestjs/common"

import { EventsRepository } from "../data/events.repository.js"
import { ReferenceRepository } from "../data/reference.repository.js"
import type { City, EnrichedEvent, Tag } from "../data/types.js"
import { encodeCursor } from "./cursor.js"
import type { ExploreQuery } from "./consumer.query.js"

export interface EventsPage {
  events: EnrichedEvent[]
  next_cursor: string | null
}

@Injectable()
export class ConsumerService {
  constructor(
    private readonly eventsRepository: EventsRepository,
    private readonly referenceRepository: ReferenceRepository
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
}
