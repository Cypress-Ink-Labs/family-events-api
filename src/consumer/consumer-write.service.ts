import { Injectable } from "@nestjs/common"

import { CalendarRepository } from "../data/calendar.repository.js"
import { CommentsRepository } from "../data/comments.repository.js"
import { FavoritesRepository } from "../data/favorites.repository.js"
import { PreferredCitiesRepository } from "../data/preferred-cities.repository.js"
import { RatingsRepository } from "../data/ratings.repository.js"
import { SubmissionsRepository } from "../data/submissions.repository.js"
import type { CommunityEventInput, PreferredCity } from "../data/types.js"

@Injectable()
export class ConsumerWriteService {
  constructor(
    private readonly favorites: FavoritesRepository,
    private readonly calendar: CalendarRepository,
    private readonly ratings: RatingsRepository,
    private readonly comments: CommentsRepository,
    private readonly submissions: SubmissionsRepository,
    private readonly preferredCities: PreferredCitiesRepository
  ) {}

  async setFavorite(userKey: string, eventId: string, on: boolean): Promise<{ ok: true }> {
    if (on) {
      await this.favorites.addFavorite(userKey, eventId)
    } else {
      await this.favorites.removeFavorite(userKey, eventId)
    }
    return { ok: true }
  }

  async setCalendar(userKey: string, eventId: string, on: boolean): Promise<{ ok: true }> {
    if (on) {
      await this.calendar.addToCalendar(userKey, eventId)
    } else {
      await this.calendar.removeFromCalendar(userKey, eventId)
    }
    return { ok: true }
  }

  async rateEvent(userKey: string, eventId: string, score: number): Promise<{ score: number }> {
    const rating = await this.ratings.upsertEventRating(userKey, eventId, score)
    return { score: rating.score }
  }

  postComment(userKey: string, eventId: string, body: string): Promise<{ id: string }> {
    return this.comments.addEventComment(userKey, eventId, body)
  }

  async removeComment(userKey: string, commentId: string): Promise<{ removed: boolean }> {
    return { removed: await this.comments.deleteOwnComment(userKey, commentId) }
  }

  submitEvent(userKey: string, input: CommunityEventInput): Promise<{ id: string }> {
    return this.submissions.submitCommunityEvent(userKey, input)
  }

  async setPreferredCities(
    userKey: string,
    cityIds: readonly string[],
    primaryCityId: string
  ): Promise<{ ok: true }> {
    await this.preferredCities.setPreferredCities(userKey, cityIds, primaryCityId)
    return { ok: true }
  }

  listPreferredCities(userKey: string): Promise<PreferredCity[]> {
    return this.preferredCities.listPreferredCities(userKey)
  }
}
