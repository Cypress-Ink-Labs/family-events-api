// Ported verbatim from family-events-backend
// supabase/functions/scrape-source/parsers/_lib/types.ts (U28).

import type { EventSourceRow, FetchedArtifact, ParsedEvent } from "../../types.js"
import type { ParserContext } from "../../parser-context.js"

export interface SourceParser<T extends string = string> {
  readonly type: T
  fetchArtifact(source: EventSourceRow, ctx: ParserContext): Promise<FetchedArtifact>
  extractEvents(
    source: EventSourceRow,
    artifact: FetchedArtifact,
    ctx: ParserContext
  ): Promise<ParsedEvent[]>
}
