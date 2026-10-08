import { BadRequestException, Injectable } from "@nestjs/common"
import { EventsRepository } from "../data/events.repository.js"
import { PlanRepository } from "../data/plan.repository.js"
import { PreferredCitiesRepository } from "../data/preferred-cities.repository.js"
import { ProfileRepository } from "../data/profile.repository.js"
import { ReferenceRepository } from "../data/reference.repository.js"
import { zonedDayStartUtc } from "../pipeline/zoned-time.js"
import type { NextPlanDto, NextPlanContextDto } from "./next-plan.dto.js"
import { WeatherService, type WeatherSnapshot } from "./weather.service.js"

export interface NextPlanInput {
  cityId?: string
  kidAge?: number
  lat?: number
  lng?: number
}

const NO_WEATHER: WeatherSnapshot = {
  available: false,
  weatherFit: "neutral",
  temperatureC: null,
  condition: null,
  observedAt: null,
}

@Injectable()
export class NextPlanService {
  constructor(
    private readonly plans: PlanRepository,
    private readonly events: EventsRepository,
    private readonly profile: ProfileRepository,
    private readonly preferred: PreferredCitiesRepository,
    private readonly reference: ReferenceRepository,
    private readonly weatherService: WeatherService
  ) {}

  async next(userId: string, input: NextPlanInput): Promise<NextPlanDto> {
    const now = new Date()
    const [profile, preferences, cities] = await Promise.all([
      this.profile.get(userId),
      this.preferred.listPreferredCities(userId),
      this.reference.listCities(),
    ])
    const preferredIds = preferences.map((row) => row.city_id)
    const cityIds = input.cityId
      ? [input.cityId]
      : preferredIds.length
        ? preferredIds
        : profile.city_preference_id
          ? [profile.city_preference_id]
          : []
    const selected = cities.filter((city) => cityIds.includes(city.id))
    if (input.cityId && !selected.length) throw new BadRequestException("Choose an active city")
    const primaryId =
      input.cityId ??
      preferences.find((row) => row.is_primary)?.city_id ??
      profile.city_preference_id
    const primary = selected.find((city) => city.id === primaryId) ?? selected[0]
    const timezone = primary?.timezone ?? "America/Chicago"
    const childAge = input.kidAge ?? profile.child_age
    const lat = input.lat ?? coordinate(primary?.latitude)
    const lng = input.lng ?? coordinate(primary?.longitude)
    const context: NextPlanContextDto = {
      child_age: childAge,
      city_ids: selected.map((city) => city.id),
      location_source:
        input.lat !== undefined ? "device" : lat !== null && lng !== null ? "city" : "none",
    }
    const weather =
      lat !== null && lng !== null ? await this.weatherService.snapshot(lat, lng) : NO_WEATHER
    const base = { available: true, timezone, context, weather }
    if (cityIds.length && !selected.length)
      return { ...base, date: null, day_offset: null, planned: [] }

    for (let offset = 0; offset <= 7; offset++) {
      const start = zonedDayStartUtc(now, timezone, offset)
      const rows = await this.plans.planForRange({
        userKey: userId,
        dateFrom: offset === 0 ? now.toISOString() : start.toISOString(),
        dateTo: zonedDayStartUtc(now, timezone, offset + 1).toISOString(),
        cityIds: selected.length ? context.city_ids : null,
        lat,
        lng,
        kidAge: childAge,
        weatherFit: offset === 0 ? weather.weatherFit : "neutral",
        limit: 5,
      })
      if (!rows.length) continue
      const events = await this.events.listEvents({
        eventIds: rows.map((row) => row.event_id),
        userKey: userId,
        limit: rows.length,
      })
      const byId = new Map(events.map((event) => [event.id, event]))
      const planned = rows.flatMap((row) => {
        const event = byId.get(row.event_id)
        if (!event) return []
        const knownAge = event.age_min !== null && event.age_max !== null
        const contradictedAge =
          childAge !== null &&
          ((event.age_min !== null && childAge < event.age_min) ||
            (event.age_max !== null && childAge > event.age_max))
        const ageMatches =
          childAge !== null &&
          knownAge &&
          childAge >= (event.age_min ?? 0) &&
          childAge <= (event.age_max ?? 99)
        const reasons: string[] = []
        if (
          row.distance_km !== null &&
          row.distance_km !== undefined &&
          Number(row.distance_score) >= 0.6
        )
          reasons.push("Close by")
        if (ageMatches) reasons.push("Matches your child's age")
        if (
          offset === 0 &&
          weather.available &&
          (weather.weatherFit === "indoor" || weather.weatherFit === "outdoor") &&
          event.family_needs[weather.weatherFit] === "confirmed" &&
          Number(row.weather_score) >= 0.6
        )
          reasons.push("Fits current weather")
        if (Number(row.history_affinity) >= 0.6) reasons.push("Matches your saved ideas")
        return [
          {
            event: {
              ...event,
              age_match:
                childAge === null
                  ? null
                  : ageMatches
                    ? ("confirmed" as const)
                    : contradictedAge
                      ? null
                      : ("unknown" as const),
            },
            score: row.score,
            reasons,
            distance_km:
              row.distance_km === null || row.distance_km === undefined
                ? null
                : Number(row.distance_km),
          },
        ]
      })
      if (planned.length)
        return { ...base, date: localDate(start, timezone), day_offset: offset, planned }
    }
    return { ...base, date: null, day_offset: null, planned: [] }
  }
}

function coordinate(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function localDate(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date)
  const value = (type: string) => parts.find((part) => part.type === type)!.value
  return `${value("year")}-${value("month")}-${value("day")}`
}
