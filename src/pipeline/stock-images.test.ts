import { describe, expect, it } from "vitest"

import { deriveTitleSearchTerm } from "./stock-images.js"

// Ported from family-events-backend supabase/functions/_shared/stock-images_test.ts (U29)

describe("deriveTitleSearchTerm", () => {
  it("strips venue suffix", () => {
    expect(deriveTitleSearchTerm("Splash Park at East Side Recreation Center")).toBe("splash park")
  })

  it("strips 'presented by' suffix", () => {
    expect(deriveTitleSearchTerm("Jazz Concert presented by BREC")).toBe("jazz concert")
  })

  it("keeps short titles", () => {
    expect(deriveTitleSearchTerm("Community Day")).toBe("community day")
  })

  it("limits to 4 words after noise filtering", () => {
    expect(deriveTitleSearchTerm("Story Time for Toddlers at the Library")).toBe(
      "story time toddlers at"
    )
  })

  it("returns null for very short input", () => {
    expect(deriveTitleSearchTerm("Run")).toBeNull()
  })

  it("strips punctuation", () => {
    expect(deriveTitleSearchTerm("Kids' Art Workshop!")).toBe("kids art workshop")
  })

  // Library context preservation tests
  it("preserves 'library' context in title", () => {
    expect(deriveTitleSearchTerm("Story Time at West Regional Library")).toBe("story time at west")
  })

  it("preserves 'library' with noise filtering", () => {
    expect(deriveTitleSearchTerm("Baby Storytime for Toddlers at Main Library")).toBe(
      "baby storytime toddlers at"
    )
  })

  it("preserves 'library' case-insensitive", () => {
    expect(deriveTitleSearchTerm("Family Movie Night at LIBRARY")).toBe("family movie night at")
  })

  it("preserves 'library' mid-title", () => {
    expect(deriveTitleSearchTerm("Library Story Hour presented by BREC")).toBe("library story hour")
  })

  it("non-library 'at' suffix still stripped", () => {
    expect(deriveTitleSearchTerm("Yoga in the Park at Community Center")).toBe("yoga park")
  })

  // Noise word filtering tests
  it("filters 'free' noise word", () => {
    expect(deriveTitleSearchTerm("Free FIFA World Cup Watch Party")).toBe("fifa world cup watch")
  })

  it("filters 'annual' noise word", () => {
    expect(deriveTitleSearchTerm("Annual Summer Reading Program")).toBe("summer reading program")
  })

  it("filters 'the' noise word", () => {
    expect(deriveTitleSearchTerm("The Great Outdoors Festival")).toBe("great outdoors festival")
  })

  it("filters multiple noise words", () => {
    expect(deriveTitleSearchTerm("Weekly Yoga in the Park")).toBe("yoga park")
  })
})
