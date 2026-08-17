// Ingestion domain types, ported verbatim from family-events-backend
// supabase/functions/scrape-source/lib/types.ts (U28). Deviation: the enum
// aliases (SourceExtractionMode, EventProcessingMode) came from the backend's
// generated packages/contracts/src/database-enums.ts; the API repo has no
// Supabase codegen, so the literal unions are inlined here. Values match the
// database enums source_extraction_mode / event_processing_mode exactly.

export type SourceExtractionMode = "deterministic" | "llm" | "deterministic_then_llm"
export type EventProcessingMode = "manual_review" | "auto_approve" | "llm_review"

export type SourceType =
  | "brec"
  | "downtownlafayette"
  | "ical"
  | "lcglafayette"
  | "localhop"
  | "macaronikid"
  | "manual"
  | "rss"
  | "website"
export type RunStatus = "running" | "success" | "error" | "partial" | "stale"
export type ExtractionMode = SourceExtractionMode

export interface FetchedArtifact {
  url: string
  contentType: string
  body: string
}

export interface EventSourceRow {
  id: string
  name: string
  url: string
  source_type: SourceType
  extraction_mode: ExtractionMode
  processing_mode?: EventProcessingMode | null
  city_id: string | null
  is_active: boolean
  auto_approve: boolean
  scrape_interval_hours: number
  last_scraped_at: string | null
  last_status: "pending" | "success" | "error" | "partial" | "stale" | null
  error_count: number
  date_window_days: number | null
  consecutive_zero_result_scrapes: number
  stale_escalated_at: string | null
}

export interface ParsedEvent {
  title: string
  description: string
  startDatetime: string
  endDatetime: string | null
  venueName: string | null
  address: string | null
  sourceUrl: string | null
  imageUrl: string | null
  images: string[]
  price: number | null
  isFree: boolean
}

export interface SourceResult {
  sourceId: string
  status: RunStatus
  eventsFound: number
  eventsImported: number
  eventsSkipped: number
  error: string | null
}
