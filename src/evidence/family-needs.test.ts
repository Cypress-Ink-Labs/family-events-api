import { describe, expect, it } from "vitest"

import { familyNeedsPredicateSql, isExplicitSourceStatement } from "./family-needs.js"

describe("family-needs evidence", () => {
  it("requires a quoted URL-backed source statement and rejects AI provenance", () => {
    expect(
      isExplicitSourceStatement({
        provenanceType: "source_statement",
        sourceUrl: "https://example.com/event",
        statement: "Wheelchair accessible entrance.",
      })
    ).toBe(true)
    expect(
      isExplicitSourceStatement({
        provenanceType: "ai",
        sourceUrl: "https://example.com/event",
        statement: "Probably accessible.",
      })
    ).toBe(false)
  })

  it("builds the shared conjunctive predicate used before Explore and Map limits", () => {
    const sql = familyNeedsPredicateSql("e", { familyNeeds: 8, includeUnknown: 9 })
    expect(sql).toContain("NOT EXISTS")
    expect(sql).toContain("unnest($8::text[])")
    expect(sql).toContain("n.state = 'contradicted'")
    expect(sql).toContain("$9::boolean")
  })
})
