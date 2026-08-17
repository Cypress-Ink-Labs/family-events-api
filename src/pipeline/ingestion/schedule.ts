// Ported from family-events-backend supabase/functions/scrape-source/lib/schedule.ts
// (U28). Deviation: upstream's resolveCityTimezone(supabase, cityId) took a
// SupabaseClient; here the city-timezone lookup lives on the ingestion DB seam
// (ProcessSourceDb.resolveCityTimezone) so only the pure due-check remains.

import type { EventSourceRow } from "./types.js"

export function isSourceDue(source: EventSourceRow): boolean {
  if (!source.last_scraped_at) {
    return true
  }

  const lastScraped = new Date(source.last_scraped_at).getTime()
  const elapsed = Date.now() - lastScraped
  return elapsed >= source.scrape_interval_hours * 60 * 60 * 1000
}
