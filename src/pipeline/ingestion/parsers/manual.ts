// Ported verbatim from family-events-backend
// supabase/functions/scrape-source/parsers/manual.ts (U28).

import type { SourceParser } from "./_lib/types.js"

export const manualParser: SourceParser<"manual"> = {
  type: "manual",
  fetchArtifact(source) {
    return Promise.resolve({
      url: source.url,
      contentType: "text/plain",
      body: "",
    })
  },
  extractEvents() {
    return Promise.resolve([])
  },
}
