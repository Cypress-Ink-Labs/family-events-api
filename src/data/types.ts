// Consumer wire shapes, kept field-for-field identical to the app's server
// data layer (family-events-app src/server/*.ts, U6).
// snake_case is deliberate: these rows ARE the contract the app already
// serves; the OpenAPI DTOs (U21/U24) freeze them, they do not rename them.
//
// Postgres numeric columns arrive as strings (node-pg default, same as the
// app's driver) and timestamptz as microsecond-precision text (db.service.ts).

import type { Json } from "../db/json.js"

export interface EnrichedEvent {
  id: string
  title: string
  description: string | null
  start_datetime: string
  end_datetime: string | null
  timezone: string | null
  venue_name: string | null
  address: string | null
  city_id: string | null
  latitude: string | null
  longitude: string | null
  age_min: number | null
  age_max: number | null
  price: string | null
  is_free: boolean
  source_url: string | null
  source_name: string | null
  images: Json
  status: string
  recurrence_info: Json
  is_featured: boolean
  view_count: number
  created_at: string
  updated_at: string
  avg_rating: string | null
  rating_count: number
  tags: Json
  is_favorited: boolean
  is_in_calendar: boolean
}

export interface EventCursor {
  startDatetime: string
  id: string
}

export interface ListEventsInput {
  cityId?: string | null
  status?: string
  limit?: number
  /** Keyset cursor: the (start_datetime, id) of the last row of the previous page. */
  after?: EventCursor | null
  /** Storage user key (supabase uuid via the U22 identity seam): personalizes is_favorited / is_in_calendar. */
  userKey?: string | null
  eventIds?: string[] | null
  dateFrom?: string | null
  dateTo?: string | null
}

export interface ListMapEventsInput {
  cityId?: string | null
  limit?: number
}

export interface MappableEvent {
  id: string
  title: string
  latitude: string
  longitude: string
  start_datetime: string
  venue_name: string | null
  is_free: boolean
}

export interface SearchEventsInput {
  keyword?: string | null
  cityId?: string | null
  dateFrom?: string | null
  dateTo?: string | null
  ageMin?: number | null
  ageMax?: number | null
  isFree?: boolean | null
  isFeatured?: boolean | null
  tagSlugs?: string[] | null
  /** Radius filter around a point (old app's explore contract). */
  lat?: number | null
  lng?: number | null
  radiusKm?: number | null
  limit?: number
  /** Keyset cursor from the last row of the previous page. */
  after?: EventCursor | null
}

/** search_events returns base event rows (SETOF public.events, no enrichment). */
export interface SearchedEvent {
  id: string
  title: string
  description: string | null
  start_datetime: string
  end_datetime: string | null
  venue_name: string | null
  address: string | null
  city_id: string | null
  latitude: string | null
  longitude: string | null
  age_min: number | null
  age_max: number | null
  price: string | null
  is_free: boolean
  images: Json
  status: string
  is_featured: boolean
}

/** Consumer detail contract: the app renders only the linked event id and title. */
export interface SimilarEvent {
  event_id: string
  title: string
}

export interface SimilarEventsInput {
  limit?: number
  cityId?: string | null
}

export interface City {
  id: string
  name: string
  state: string | null
  slug: string
  timezone: string
  latitude: string | null
  longitude: string | null
}

export interface Tag {
  id: string
  name: string
  slug: string
  color: string
}

export interface Favorite {
  id: string
  user_id: string
  event_id: string
  created_at: string
}

export interface CalendarEvent {
  event_id: string
  added_at: string
  notes: string | null
  title: string
  start_datetime: string
  end_datetime: string | null
  venue_name: string | null
  address: string | null
  city_id: string | null
  is_free: boolean
  price: string | null
  images: Json
}

export interface Rating {
  id: string
  user_id: string
  event_id: string
  score: number
  created_at: string
}

export interface EventComment {
  id: string
  user_id: string
  event_id: string
  body: string
  is_approved: boolean
  is_flagged: boolean
  created_at: string
  updated_at: string
  display_name: string | null
  avatar_url: string | null
}

/** Public detail-page projection; moderation and ownership fields stay server-side. */
export interface PublicEventComment {
  id: string
  body: string
  created_at: string
  updated_at: string
  display_name: string | null
  avatar_url: string | null
}

export interface CommunityEventInput {
  title: string
  description?: string | null
  startDatetime: string
  endDatetime?: string | null
  venueName?: string | null
  address?: string | null
  cityId: string
  ageMin?: number | null
  ageMax?: number | null
  isFree?: boolean
  price?: number | null
}

export interface PreferredCity {
  user_id: string
  city_id: string
  is_primary: boolean
  created_at: string
}

export interface PlanForRangeInput {
  userKey: string
  dateFrom: string
  dateTo: string
  cityIds?: string[] | null
  lat?: number | null
  lng?: number | null
  kidAge?: number | null
  weatherFit?: string
  limit?: number
}

/** Ranked planner row: family-events-app src/server/events.ts PlannedEvent. */
export interface PlannedEvent {
  event_id: string
  score: string
  start_datetime: string
  city_id: string | null
  title: string
  venue_name: string | null
  address: string | null
  is_free: boolean
  price: string | null
  images: Json
  /** Ranking factors are used by the email digest explanation copy. */
  distance_score?: string | null
  weather_score?: string | null
  age_score?: string | null
  history_affinity?: string | null
  family_fit_score?: string | null
  timing_score?: string | null
  novelty_score?: string | null
  budget_score?: string | null
  distance_km?: string | null
}
