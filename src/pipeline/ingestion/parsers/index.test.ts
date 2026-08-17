import { describe, expect, it } from "vitest"

import { parsers } from "./index.js"

// Ported from family-events-backend scrape-source/parsers/index_test.ts (U28),
// converted from Deno.test to vitest.
//
// Keep this list in lockstep with the consolidated event_sources.source_type
// CHECK constraint. If you add a parser, update both the schema baseline and
// this test so the TS-side registry and DB-side CHECK cannot silently drift.
const DB_ALLOWED_SOURCE_TYPES = [
  "brec",
  "downtownlafayette",
  "ical",
  "lcglafayette",
  "localhop",
  "macaronikid",
  "manual",
  "rss",
  "website",
]

describe("parser registry", () => {
  it("keys match the DB CHECK constraint allowlist", () => {
    expect(Object.keys(parsers).slice().sort()).toEqual(DB_ALLOWED_SOURCE_TYPES.slice().sort())
  })

  it("each registered parser exposes the correct type tag", () => {
    for (const [key, parser] of Object.entries(parsers)) {
      expect(parser.type).toBe(key)
    }
  })
})
