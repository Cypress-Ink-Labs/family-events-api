import { describe, expect, it } from "vitest"

import { deriveTitleSearchTerm, findFallbackImage } from "./stock-images.js"

// Ported from family-events-backend supabase/functions/_shared/stock-images_test.ts (U29).
// CodeRabbit U29 review: the four "preserves 'library'" expectations were
// updated because they enshrined the dropped-library output the review fixed
// (the term must now retain the word "library"); the findFallbackImage
// incomplete-response coverage is also new.

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
      "time toddlers at library"
    )
  })

  it("returns null for very short input", () => {
    expect(deriveTitleSearchTerm("Run")).toBeNull()
  })

  it("strips punctuation", () => {
    expect(deriveTitleSearchTerm("Kids' Art Workshop!")).toBe("kids art workshop")
  })

  // Library context preservation tests.
  // CodeRabbit U29 review: when the cap would drop "library" from the window,
  // the window ending at "library" is kept instead, so every term below
  // retains the word "library".
  it("preserves 'library' context in title", () => {
    expect(deriveTitleSearchTerm("Story Time at West Regional Library")).toBe(
      "at west regional library"
    )
  })

  it("preserves 'library' with noise filtering", () => {
    expect(deriveTitleSearchTerm("Baby Storytime for Toddlers at Main Library")).toBe(
      "toddlers at main library"
    )
  })

  it("preserves 'library' case-insensitive", () => {
    expect(deriveTitleSearchTerm("Family Movie Night at LIBRARY")).toBe("movie night at library")
  })

  it("preserves 'library' mid-title", () => {
    expect(deriveTitleSearchTerm("Library Story Hour presented by BREC")).toBe("library story hour")
  })

  it("keeps the window ending at 'library' for long titles", () => {
    expect(
      deriveTitleSearchTerm("Summer Reading Kickoff Party at Jones Creek Regional Branch Library")
    ).toBe("creek regional branch library")
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

// ── findFallbackImage incomplete-response handling (CodeRabbit U29 review) ───

const pexelsPhoto = (id: number, large: string) => ({
  id,
  url: `https://www.pexels.com/photo/${id}`,
  photographer: `Photographer ${id}`,
  photographer_url: `https://www.pexels.com/@photographer${id}`,
  src: { large, large2x: "", medium: "", original: "" },
})

const pixabayHit = (id: number, largeImageURL: string) => ({
  id,
  pageURL: `https://pixabay.com/photos/${id}`,
  largeImageURL,
  user: `user${id}`,
  user_id: id,
})

const unsplashHit = {
  id: "unsplash-1",
  urls: { regular: "https://images.unsplash.com/photo-1?w=1080" },
  links: {
    html: "https://unsplash.com/photos/unsplash-1",
    download_location: "https://api.unsplash.com/photos/unsplash-1/download",
  },
  user: {
    name: "Unsplash Photographer",
    username: "unphotog",
    links: { html: "https://unsplash.com/@unphotog" },
  },
}

/** Fake fetch that serves each provider's payload by request URL. */
function providerFetch(payloads: {
  pexels?: unknown
  pixabay?: unknown
  unsplash?: unknown
}): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input)
    let payload: unknown
    if (url.includes("api.pexels.com")) payload = payloads.pexels ?? { photos: [] }
    else if (url.includes("pixabay.com/api")) payload = payloads.pixabay ?? { hits: [] }
    else payload = payloads.unsplash ?? { results: [] }
    return { ok: true, json: async () => payload } as unknown as Response
  }) as unknown as typeof fetch
}

describe("findFallbackImage incomplete-response handling", () => {
  // Pexels

  it("skips a Pexels record with an unusable image URL and uses the next valid record", async () => {
    const result = await findFallbackImage(
      ["park"],
      { pexels: "pexels-key" },
      {
        fetchImpl: providerFetch({
          pexels: {
            photos: [
              pexelsPhoto(1, ""),
              pexelsPhoto(2, "https://images.pexels.com/photos/2/large.jpg"),
            ],
          },
        }),
      }
    )
    expect(result?.url).toBe("https://images.pexels.com/photos/2/large.jpg")
    expect(result?.attribution.photoId).toBe("2")
    expect(result?.matchedTag).toBe("park")
    expect(result?.attribution.provider).toBe("pexels")
  })

  it("returns null when every Pexels record has an unusable image URL", async () => {
    const result = await findFallbackImage(
      ["park"],
      { pexels: "pexels-key" },
      {
        fetchImpl: providerFetch({
          pexels: {
            photos: [
              pexelsPhoto(1, ""),
              { ...pexelsPhoto(2, ""), src: {} }, // partial response: no URL fields at all
              pexelsPhoto(3, "   "),
            ],
          },
        }),
      }
    )
    expect(result).toBeNull()
  })

  it("continues to the next provider when Pexels returns only unusable records", async () => {
    const result = await findFallbackImage(
      ["park"],
      { pexels: "pexels-key", unsplash: "unsplash-key" },
      {
        fetchImpl: providerFetch({
          pexels: { photos: [{ ...pexelsPhoto(1, " "), src: {} }] },
          unsplash: { results: [unsplashHit] },
        }),
      }
    )
    expect(result?.attribution.provider).toBe("unsplash")
    expect(result?.url).toBe("https://images.unsplash.com/photo-1?w=1080")
  })

  // Pixabay

  it("skips a Pixabay hit with an unusable image URL and uses the next valid hit", async () => {
    const result = await findFallbackImage(
      ["park"],
      { pixabay: "pixabay-key" },
      {
        fetchImpl: providerFetch({
          pixabay: {
            hits: [pixabayHit(1, ""), pixabayHit(2, "https://pixabay.com/get/2.jpg")],
          },
        }),
      }
    )
    expect(result?.url).toBe("https://pixabay.com/get/2.jpg")
    expect(result?.attribution.photoId).toBe("2")
    expect(result?.attribution.provider).toBe("pixabay")
  })

  it("returns null when every Pixabay hit has an unusable image URL", async () => {
    const result = await findFallbackImage(
      ["park"],
      { pixabay: "pixabay-key" },
      {
        fetchImpl: providerFetch({
          pixabay: { hits: [pixabayHit(1, ""), pixabayHit(2, "   ")] },
        }),
      }
    )
    expect(result).toBeNull()
  })

  it("continues to the next provider when Pixabay returns only unusable hits", async () => {
    const result = await findFallbackImage(
      ["park"],
      { pixabay: "pixabay-key", unsplash: "unsplash-key" },
      {
        fetchImpl: providerFetch({
          pixabay: { hits: [pixabayHit(1, "")] },
          unsplash: { results: [unsplashHit] },
        }),
      }
    )
    expect(result?.attribution.provider).toBe("unsplash")
    expect(result?.url).toBe("https://images.unsplash.com/photo-1?w=1080")
  })
})
