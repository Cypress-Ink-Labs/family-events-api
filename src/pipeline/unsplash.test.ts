import { describe, expect, it, vi } from "vitest"

import { deriveTitleSearchTerm, findFallbackImage, trackUnsplashDownload } from "./unsplash.js"

// Ported from family-events-backend supabase/functions/_shared/unsplash.test.ts (U29)

// Loosely typed so mocks with narrower call signatures (e.g. accepting only
// `string | URL`, or no arguments at all) can stand in for the real `fetch`,
// whose signature also allows `Request` as the first argument.
function mockFetch(impl: unknown): typeof fetch {
  return impl as typeof fetch
}

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  })
}

function unsplashHit(overrides: Record<string, unknown> = {}) {
  return {
    id: "abc",
    urls: { regular: "https://images.unsplash.com/photo-museum.jpg" },
    links: {
      html: "https://unsplash.com/photos/abc",
      download_location: "https://api.unsplash.com/photos/abc/download",
    },
    user: {
      name: "Jane Doe",
      username: "jane",
      links: { html: "https://unsplash.com/@jane" },
    },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// deriveTitleSearchTerm
// ---------------------------------------------------------------------------

describe("deriveTitleSearchTerm", () => {
  it("returns null for an empty string", () => {
    expect(deriveTitleSearchTerm("")).toBeNull()
  })

  it("returns null for a very short string after normalization", () => {
    expect(deriveTitleSearchTerm("Hi")).toBeNull()
  })

  it("strips 'at <Venue>' suffix", () => {
    expect(deriveTitleSearchTerm("Splash Park at East Side Recreation Center")).toBe("splash park")
  })

  it("strips 'presented by …' suffix", () => {
    expect(deriveTitleSearchTerm("Summer Reading presented by BREC")).toBe("summer reading")
  })

  it("strips 'hosted by …' suffix", () => {
    expect(deriveTitleSearchTerm("Storytime hosted by the Library")).toBe("storytime")
  })

  it("strips 'sponsored by …' suffix", () => {
    expect(deriveTitleSearchTerm("Craft Fair sponsored by Arts Council")).toBe("craft fair")
  })

  it("takes up to 4 words", () => {
    expect(deriveTitleSearchTerm("Thanksgiving Story Time for Families")).toBe(
      "thanksgiving story time for"
    )
  })

  it("strips punctuation", () => {
    expect(deriveTitleSearchTerm("Art & Crafts! Workshop")).toBe("art crafts workshop")
  })

  it("lowercases output", () => {
    expect(deriveTitleSearchTerm("Splash Park")).toBe("splash park")
  })

  it("handles a plain short title without a venue suffix", () => {
    expect(deriveTitleSearchTerm("Community Day")).toBe("community day")
  })
})

// ---------------------------------------------------------------------------
// findFallbackImage
// ---------------------------------------------------------------------------

describe("findFallbackImage", () => {
  it("returns null when access key is missing", async () => {
    const fetchSpy = vi.fn()
    const result = await findFallbackImage(["museum"], "", { fetchImpl: mockFetch(fetchSpy) })
    expect(result).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("returns null when tag list is empty and no title supplied", async () => {
    const fetchSpy = vi.fn()
    const result = await findFallbackImage([], "key", { fetchImpl: mockFetch(fetchSpy) })
    expect(result).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("uses the title-derived term before tag slugs", async () => {
    const fetchSpy = vi.fn(async (_url: string | URL) => jsonResponse({ results: [unsplashHit()] }))
    const result = await findFallbackImage(["sports"], "key", {
      fetchImpl: mockFetch(fetchSpy),
      title: "Splash Park at East Side Recreation Center",
    })
    // Two-pass: tries "splash park" first (bare), gets results → succeeds without suffix
    expect(result?.matchedTag).toBe("splash park")
    const firstCall = fetchSpy.mock.calls[0]?.[0] as string
    expect(firstCall).toContain("query=splash%20park")
    expect(firstCall).not.toContain("family")
    // Only one fetch — bare title query succeeded, never tried suffix or tag slug
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it("falls through to tag slugs when title query returns no results", async () => {
    const fetchSpy = vi.fn(async (url: string | URL) => {
      const target = url.toString()
      // Two-pass for "splash park": both bare and suffix return empty
      if (target.includes("query=splash%20park")) {
        return jsonResponse({ results: [] })
      }
      // Two-pass for "sports": bare succeeds immediately
      if (target.includes("query=sports") && !target.includes("family")) {
        return jsonResponse({
          results: [unsplashHit({ urls: { regular: "https://images.unsplash.com/sports.jpg" } })],
        })
      }
      return new Response(null, { status: 200 })
    })
    const result = await findFallbackImage(["sports"], "key", {
      fetchImpl: mockFetch(fetchSpy),
      title: "Splash Park",
    })
    expect(result?.url).toBe("https://images.unsplash.com/sports.jpg")
    expect(result?.matchedTag).toBe("sports")
    // 2 calls for "splash park" (bare + suffix both empty), 1 for "sports" (bare succeeds)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it("hits the search endpoint and returns image plus attribution metadata", async () => {
    const fetchSpy = vi.fn(async (_url: string | URL) => jsonResponse({ results: [unsplashHit()] }))
    const result = await findFallbackImage(["museum", "art"], "key", {
      fetchImpl: mockFetch(fetchSpy),
    })
    expect(result).toEqual({
      url: "https://images.unsplash.com/photo-museum.jpg",
      matchedTag: "museum",
      attribution: {
        photoId: "abc",
        photographerName: "Jane Doe",
        photographerUsername: "jane",
        photographerProfileUrl: "https://unsplash.com/@jane",
        photoUrl: "https://unsplash.com/photos/abc",
        downloadLocation: "https://api.unsplash.com/photos/abc/download",
      },
    })
    const firstCall = fetchSpy.mock.calls[0]?.[0] as string
    expect(firstCall).toContain("query=museum")
    expect(firstCall).toContain("orientation=landscape")
    expect(firstCall).toContain("per_page=5")
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it("does not fire-and-forget the download tracking endpoint", async () => {
    const fetchSpy = vi.fn(async (_url: string | URL) => jsonResponse({ results: [unsplashHit()] }))
    await findFallbackImage(["concert"], "key", { fetchImpl: mockFetch(fetchSpy) })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const firstCall = fetchSpy.mock.calls[0]?.[0] as string
    expect(firstCall.includes("/search/photos")).toBe(true)
  })

  it("skips hits missing required attribution metadata", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse({
        results: [unsplashHit({ links: { html: "https://unsplash.com/photos/abc" } })],
      })
    )
    const result = await findFallbackImage(["museum"], "key", { fetchImpl: mockFetch(fetchSpy) })
    expect(result).toBeNull()
  })

  it("falls through to the next tag when the first one yields no results", async () => {
    const fetchSpy = vi.fn(async (url: string | URL) => {
      const target = url.toString()
      // Two-pass for "obscure": both bare and suffix return empty
      if (target.includes("query=obscure")) {
        return jsonResponse({ results: [] })
      }
      // Two-pass for "park": bare succeeds
      if (target.includes("query=park") && !target.includes("family")) {
        return jsonResponse({
          results: [unsplashHit({ urls: { regular: "https://images.unsplash.com/park.jpg" } })],
        })
      }
      return new Response(null, { status: 200 })
    })
    const result = await findFallbackImage(["obscure", "park"], "key", {
      fetchImpl: mockFetch(fetchSpy),
    })
    expect(result?.url).toBe("https://images.unsplash.com/park.jpg")
    expect(result?.matchedTag).toBe("park")
    // 2 calls for "obscure" (bare + suffix both empty), 1 for "park" (bare succeeds)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it("returns null when every candidate misses", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ results: [] }))
    const result = await findFallbackImage(["a", "b", "c"], "key", {
      fetchImpl: mockFetch(fetchSpy),
    })
    expect(result).toBeNull()
    // 2 passes per term × 3 terms = 6 calls
    expect(fetchSpy).toHaveBeenCalledTimes(6)
  })

  it("treats non-2xx as a miss and tries the next candidate", async () => {
    const fetchSpy = vi.fn(async (url: string | URL) => {
      const target = url.toString()
      if (target.includes("query=rate")) {
        return new Response("rate limited", { status: 429 })
      }
      if (target.includes("query=art") && !target.includes("family")) {
        return jsonResponse({
          results: [unsplashHit({ urls: { regular: "https://images.unsplash.com/art.jpg" } })],
        })
      }
      return new Response(null, { status: 200 })
    })
    const result = await findFallbackImage(["rate", "art"], "key", {
      fetchImpl: mockFetch(fetchSpy),
    })
    expect(result?.url).toBe("https://images.unsplash.com/art.jpg")
  })

  it("swallows network errors and tries the next candidate", async () => {
    const fetchSpy = vi.fn(async (url: string | URL) => {
      const target = url.toString()
      if (target.includes("query=broken")) {
        throw new Error("network down")
      }
      if (target.includes("query=ok") && !target.includes("family")) {
        return jsonResponse({
          results: [unsplashHit({ urls: { regular: "https://images.unsplash.com/ok.jpg" } })],
        })
      }
      return new Response(null, { status: 200 })
    })
    const result = await findFallbackImage(["broken", "ok"], "key", {
      fetchImpl: mockFetch(fetchSpy),
    })
    expect(result?.url).toBe("https://images.unsplash.com/ok.jpg")
  })

  it("ignores blank tag entries", async () => {
    const fetchSpy = vi.fn(async (_url: string | URL) =>
      jsonResponse({
        results: [unsplashHit({ urls: { regular: "https://images.unsplash.com/y.jpg" } })],
      })
    )
    const result = await findFallbackImage(["", "   ", "library"], "key", {
      fetchImpl: mockFetch(fetchSpy),
    })
    expect(result?.matchedTag).toBe("library")
    const firstCall = fetchSpy.mock.calls[0]?.[0] as string
    expect(firstCall).toContain("query=library")
  })

  it("picks randomly among multiple results", async () => {
    // Seed Math.random to return 0.9 → picks the last result out of 3
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.9)
    const results = [
      unsplashHit({ id: "r0", urls: { regular: "https://images.unsplash.com/r0.jpg" } }),
      unsplashHit({ id: "r1", urls: { regular: "https://images.unsplash.com/r1.jpg" } }),
      unsplashHit({
        id: "r2",
        urls: { regular: "https://images.unsplash.com/r2.jpg" },
        links: {
          html: "https://unsplash.com/photos/r2",
          download_location: "https://api.unsplash.com/photos/r2/download",
        },
      }),
    ]
    const fetchSpy = vi.fn(async () => jsonResponse({ results }))
    const result = await findFallbackImage(["art"], "key", { fetchImpl: mockFetch(fetchSpy) })
    // Math.floor(0.9 * 3) = 2 → picks index 2
    expect(result?.url).toBe("https://images.unsplash.com/r2.jpg")
    randomSpy.mockRestore()
  })

  // Two-pass specific tests
  describe("two-pass search strategy", () => {
    it("tries bare term first and succeeds without falling back to suffix", async () => {
      const fetchSpy = vi.fn(async (url: string | URL) => {
        const target = url.toString()
        // Bare "yoga" returns results → suffix never tried
        if (target.includes("query=yoga") && !target.includes("family")) {
          return jsonResponse({
            results: [unsplashHit({ urls: { regular: "https://images.unsplash.com/yoga.jpg" } })],
          })
        }
        return jsonResponse({ results: [] })
      })
      const result = await findFallbackImage(["yoga"], "key", { fetchImpl: mockFetch(fetchSpy) })
      expect(result?.url).toBe("https://images.unsplash.com/yoga.jpg")
      expect(result?.matchedTag).toBe("yoga")
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it("falls back to suffix when bare term returns empty", async () => {
      const fetchSpy = vi.fn(async (url: string | URL) => {
        const target = url.toString()
        // Bare "obscure-term" returns empty
        if (target.includes("query=obscure-term") && !target.includes("family")) {
          return jsonResponse({ results: [] })
        }
        // Suffix "obscure-term family" succeeds
        if (target.includes("query=obscure-term%20family")) {
          return jsonResponse({
            results: [unsplashHit({ urls: { regular: "https://images.unsplash.com/family.jpg" } })],
          })
        }
        return jsonResponse({ results: [] })
      })
      const result = await findFallbackImage(["obscure-term"], "key", {
        fetchImpl: mockFetch(fetchSpy),
      })
      expect(result?.url).toBe("https://images.unsplash.com/family.jpg")
      expect(result?.matchedTag).toBe("obscure-term family")
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })

    it("tries both passes before moving to next term", async () => {
      const fetchSpy = vi.fn(async (url: string | URL) => {
        const target = url.toString()
        // "first": both bare and suffix return empty
        if (target.includes("query=first")) {
          return jsonResponse({ results: [] })
        }
        // "second": bare succeeds
        if (target.includes("query=second") && !target.includes("family")) {
          return jsonResponse({
            results: [unsplashHit({ urls: { regular: "https://images.unsplash.com/second.jpg" } })],
          })
        }
        return jsonResponse({ results: [] })
      })
      const result = await findFallbackImage(["first", "second"], "key", {
        fetchImpl: mockFetch(fetchSpy),
      })
      expect(result?.url).toBe("https://images.unsplash.com/second.jpg")
      expect(result?.matchedTag).toBe("second")
      // 2 calls for "first" (bare + suffix), 1 for "second" (bare succeeds)
      expect(fetchSpy).toHaveBeenCalledTimes(3)
    })
  })
})

// ---------------------------------------------------------------------------
// trackUnsplashDownload
// ---------------------------------------------------------------------------

describe("trackUnsplashDownload", () => {
  it("awaits the download tracking endpoint and returns success", async () => {
    const fetchSpy = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(null, { status: 200 })
    )
    const result = await trackUnsplashDownload(
      "https://api.unsplash.com/photos/abc/download",
      "key",
      {
        fetchImpl: mockFetch(fetchSpy),
      }
    )

    expect(result).toEqual({ ok: true, error: null })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: "Client-ID key", "Accept-Version": "v1" },
    })
  })

  it("returns a failure result for HTTP errors", async () => {
    const fetchSpy = vi.fn(async () => new Response("rate limited", { status: 429 }))
    const result = await trackUnsplashDownload(
      "https://api.unsplash.com/photos/abc/download",
      "key",
      {
        fetchImpl: mockFetch(fetchSpy),
      }
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain("HTTP 429")
  })

  it("returns a failure result for network errors", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("network down")
    })
    const result = await trackUnsplashDownload(
      "https://api.unsplash.com/photos/abc/download",
      "key",
      {
        fetchImpl: mockFetch(fetchSpy),
      }
    )
    expect(result).toEqual({ ok: false, error: "network down" })
  })
})
