import { Injectable } from "@nestjs/common"

import { DbService } from "../db/db.service.js"
import type { PlanForRangeInput, PlannedEvent } from "./types.js"

// Consumer plan reads (U26): port of family-events-app planForRange.
// Named-parameter RPC call; defaults match the app (weatherFit neutral, limit 5).

const PLAN_SQL = `
SELECT
  event_id, score, start_datetime, city_id, title, venue_name,
  address, is_free, price, images,
  distance_score, weather_score, age_score, history_affinity,
  family_fit_score, timing_score, novelty_score, budget_score, distance_km
FROM public.plan_events_for_user_range(
  p_user_id     => $1::uuid,
  p_date_from   => $2::timestamptz,
  p_date_to     => $3::timestamptz,
  p_city_ids    => $4::uuid[],
  p_lat         => $5::double precision,
  p_lng         => $6::double precision,
  p_kid_age     => $7::int,
  p_weather_fit => $8::text,
  p_limit       => $9::int
)
`

@Injectable()
export class PlanRepository {
  constructor(private readonly db: DbService) {}

  async planForRange(input: PlanForRangeInput): Promise<PlannedEvent[]> {
    return this.db.query<PlannedEvent>(PLAN_SQL, [
      input.userKey,
      input.dateFrom,
      input.dateTo,
      input.cityIds ?? null,
      input.lat ?? null,
      input.lng ?? null,
      input.kidAge ?? null,
      input.weatherFit ?? "neutral",
      input.limit ?? 5,
    ])
  }
}
