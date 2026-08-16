import type { Json } from "../db/json.js"

/** Public v1 event object from family-events-backend PUBLIC_API.md. */
export interface EventTag {
  id: string
  name: string
  slug: string
  color: string
}

export interface PublicEvent {
  id: string
  title: string
  description: string | null
  startDatetime: string
  endDatetime: string | null
  timezone: string | null
  venueName: string | null
  address: string | null
  cityId: string | null
  latitude: number | null
  longitude: number | null
  ageMin: number | null
  ageMax: number | null
  price: number | null
  isFree: boolean
  isFeatured: boolean
  isOutdoor: boolean | null
  images: Json[]
  tags: EventTag[]
  sourceUrl: string | null
}

export interface EventListQuery {
  cityId?: string | null
  dateFrom?: string | null
  dateTo?: string | null
  isFree?: boolean | null
  tagSlugs?: string[] | null
  keyword?: string | null
  limit: number
  cursor?: { afterStart: string; afterId: string } | null
}

export interface EventListResult {
  items: PublicEvent[]
  nextCursor: string | null
}

export interface City {
  id: string
  name: string
  slug: string
  state: string | null
  country: string
  timezone: string
  latitude: number | null
  longitude: number | null
  isActive: boolean
}

export interface EventRow {
  id: string
  title: string
  description: string | null
  start_datetime: string
  end_datetime: string | null
  timezone: string | null
  venue_name: string | null
  address: string | null
  city_id: string | null
  latitude: number | null
  longitude: number | null
  age_min: number | null
  age_max: number | null
  price: number | string | null
  is_free: boolean
  is_featured: boolean
  is_outdoor: boolean | null
  images: Json | Json[] | null
  source_url: string | null
}

export interface TagRow {
  event_id: string
  id: string
  name: string
  slug: string
  color: string
}

export function projectEvent(row: EventRow, tags: EventTag[]): PublicEvent {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    startDatetime: row.start_datetime,
    endDatetime: row.end_datetime,
    timezone: row.timezone,
    venueName: row.venue_name,
    address: row.address,
    cityId: row.city_id,
    latitude: row.latitude,
    longitude: row.longitude,
    ageMin: row.age_min,
    ageMax: row.age_max,
    price: row.price === null ? null : Number(row.price),
    isFree: row.is_free,
    isFeatured: row.is_featured,
    isOutdoor: row.is_outdoor,
    images: Array.isArray(row.images) ? row.images : [],
    tags,
    sourceUrl: row.source_url,
  }
}

export function escapeIlike(keyword: string): string {
  return keyword.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")
}
