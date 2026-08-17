// Ported verbatim from family-events-backend
// supabase/functions/scrape-source/lib/event-processing.ts (U28).

import type { EventProcessingMode, EventSourceRow } from "./types.js"

export function resolveProcessingMode(source: EventSourceRow): EventProcessingMode {
  if (source.processing_mode) {
    return source.processing_mode
  }
  return source.auto_approve ? "auto_approve" : "manual_review"
}
