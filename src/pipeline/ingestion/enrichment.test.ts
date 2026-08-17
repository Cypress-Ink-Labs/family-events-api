import { afterEach, describe, expect, it, vi } from "vitest"

import { sanitizeImagesForIngest } from "./enrichment.js"
import type { ParsedEvent } from "./types.js"

// New coverage for the ingest image allowlist (upstream shipped without a
// dedicated test file): https-only, source-host + default-CDN allowlist,
// content-type and size checks, per-event cap.

function buildParsed(overrides: Partial<ParsedEvent> = {}): ParsedEvent {
  return {
    title: "Story Time",
    description: "",
    startDatetime: "2026-06-01T10:00:00Z",
    endDatetime: null,
    venueName: null,
    address: null,
    sourceUrl: null,
    imageUrl: null,
    images: [],
    price: null,
    isFree: false,
    ...overrides,
  }
}

const okResolve = async () => ({ ok: true })

function imageHeadResponse(url: string, bytes = 1024): Response {
  const response = new Response(null, {
    status: 200,
    headers: { "content-type": "image/jpeg", "content-length": String(bytes) },
  })
  Object.defineProperty(response, "url", { value: url })
  return response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("sanitizeImagesForIngest", () => {
  it("keeps https images on the source host and drops other hosts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => imageHeadResponse(String(url)))
    )

    const images = await sanitizeImagesForIngest(
      buildParsed({
        images: ["https://venue.example.com/a.jpg", "https://evil.example.net/b.jpg"],
      }),
      "https://venue.example.com/events",
      { resolve: okResolve }
    )

    expect(images).toEqual(["https://venue.example.com/a.jpg"])
  })

  it("allows default CDN hosts (unsplash) even when off the source host", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => imageHeadResponse(String(url)))
    )

    const images = await sanitizeImagesForIngest(
      buildParsed({ imageUrl: "https://images.unsplash.com/photo-1.jpg" }),
      "https://venue.example.com/events",
      { resolve: okResolve }
    )

    expect(images).toEqual(["https://images.unsplash.com/photo-1.jpg"])
  })

  it("drops plain-http images even on the source host", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => imageHeadResponse(String(url)))
    )

    const images = await sanitizeImagesForIngest(
      buildParsed({ images: ["http://venue.example.com/a.jpg"] }),
      "https://venue.example.com/events",
      { resolve: okResolve }
    )

    expect(images).toEqual([])
  })

  it("drops non-image content types and oversized bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const target = String(url)
        if (target.endsWith("page.html")) {
          const response = new Response(null, {
            status: 200,
            headers: { "content-type": "text/html", "content-length": "100" },
          })
          Object.defineProperty(response, "url", { value: target })
          return response
        }
        return imageHeadResponse(target, 10 * 1024 * 1024)
      })
    )

    const images = await sanitizeImagesForIngest(
      buildParsed({
        images: ["https://venue.example.com/page.html", "https://venue.example.com/huge.jpg"],
      }),
      "https://venue.example.com/events",
      { resolve: okResolve }
    )

    expect(images).toEqual([])
  })

  it("caps validated images at five per event", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => imageHeadResponse(String(url)))
    )

    const images = await sanitizeImagesForIngest(
      buildParsed({
        images: Array.from({ length: 8 }, (_, i) => `https://venue.example.com/photo-${i}.jpg`),
      }),
      "https://venue.example.com/events",
      { resolve: okResolve }
    )

    expect(images).toHaveLength(5)
  })

  it("bounds the candidate list so pages full of broken URLs cannot stall the worker", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }))
    vi.stubGlobal("fetch", fetchMock)

    const images = await sanitizeImagesForIngest(
      buildParsed({
        // 60 candidates that all fail validation — only the first 20 may be tried.
        images: Array.from({ length: 60 }, (_, i) => `https://venue.example.com/broken-${i}.jpg`),
      }),
      "https://venue.example.com/events",
      { resolve: okResolve }
    )

    expect(images).toEqual([])
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(20)
  })
})
