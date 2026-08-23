import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildGeocodeQuery, geocodeViaNominatim } from "./geocode.js"

// Ported from family-events-backend supabase/functions/_shared/geocode.test.ts (U29).
// The geocodeViaNominatim coverage below is new (CodeRabbit U29 review): it
// pins the runtime validation of Nominatim hit coordinates. Fake timers drive
// the module-level 1 req/sec rate-limit queue so the suite stays fast despite
// the shared limiter state across tests.

describe("buildGeocodeQuery", () => {
  it("address with same city+state as parts does not duplicate", () => {
    expect(
      buildGeocodeQuery({
        address: "444 Cajundome Blvd, Lafayette, LA, 70506",
        venueName: "Cajundome",
        cityName: "Lafayette",
        cityState: "LA",
      })
    ).toBe("444 Cajundome Blvd, Lafayette, LA, 70506")
  })

  it("address with different city but inline state is returned unchanged", () => {
    // city_id points to Lafayette but venue is in Broussard — hasInlineState fires
    expect(
      buildGeocodeQuery({
        address: "701 St. Nazaire, Broussard, LA, 70518",
        venueName: null,
        cityName: "Lafayette",
        cityState: "LA",
      })
    ).toBe("701 St. Nazaire, Broussard, LA, 70518")
  })

  it("venueName-only with no inline state appends city+state", () => {
    expect(
      buildGeocodeQuery({
        address: null,
        venueName: "Moncus Park",
        cityName: "Lafayette",
        cityState: "LA",
      })
    ).toBe("Moncus Park, Lafayette, LA")
  })

  it("null address and null venueName returns null", () => {
    expect(
      buildGeocodeQuery({
        address: null,
        venueName: null,
        cityName: "Lafayette",
        cityState: "LA",
      })
    ).toBeNull()
  })

  it("address with inline state but null cityName/cityState returned unchanged", () => {
    expect(
      buildGeocodeQuery({
        address: "123 Main St, Houston, TX, 77001",
        venueName: null,
        cityName: null,
        cityState: null,
      })
    ).toBe("123 Main St, Houston, TX, 77001")
  })

  it("address with no state and cityName provided appends city", () => {
    expect(
      buildGeocodeQuery({
        address: "301 W Congress St",
        venueName: null,
        cityName: "Lafayette",
        cityState: null,
      })
    ).toBe("301 W Congress St, Lafayette")
  })

  it("address ending in ', LA' (no zip) returned unchanged", () => {
    expect(
      buildGeocodeQuery({
        address: "123 Main St, Lafayette, LA",
        venueName: null,
        cityName: "Lafayette",
        cityState: "LA",
      })
    ).toBe("123 Main St, Lafayette, LA")
  })

  it("city in address but no state appends state only", () => {
    expect(
      buildGeocodeQuery({
        address: "123 Main, Lafayette",
        venueName: null,
        cityName: "Lafayette",
        cityState: "LA",
      })
    ).toBe("123 Main, Lafayette, LA")
  })
})

// ── buildGeocodeQuery regex-metacharacter safety (CodeRabbit U29 review) ─────

describe("buildGeocodeQuery regex safety", () => {
  it("does not throw when cityState consists of regex metacharacters", () => {
    // Unescaped, "[" produces an unterminated character class (SyntaxError).
    expect(
      buildGeocodeQuery({
        address: "123 Main St",
        venueName: null,
        cityName: null,
        cityState: "[",
      })
    ).toBe("123 Main St, [")
  })

  it("treats metacharacter-containing cityState literally instead of as a pattern", () => {
    // Unescaped, "LA|TX" alternates and a bare "TX" in the address satisfies
    // stateMentioned; escaped, only the literal sequence "LA|TX" counts.
    expect(
      buildGeocodeQuery({
        address: "Harvest Festival Downtown TX",
        venueName: null,
        cityName: null,
        cityState: "LA|TX",
      })
    ).toBe("Harvest Festival Downtown TX, LA|TX")
  })

  it("still detects a metacharacter-containing cityState present verbatim", () => {
    // "(LA)" matches literally at word boundaries; the base is returned
    // unchanged because the state was already mentioned.
    expect(
      buildGeocodeQuery({
        address: "Harvest Fest (LA) Hall",
        venueName: null,
        cityName: null,
        cityState: "(LA)",
      })
    ).toBe("Harvest Fest (LA) Hall")
  })
})

// ── geocodeViaNominatim hit validation (CodeRabbit U29 review) ───────────────

function stubNominatimResponse(payload: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => payload }) as unknown as Response)
  )
}

describe("geocodeViaNominatim", () => {
  beforeEach(() => {
    // Fake only the timer APIs (the rate limiter's sleep) and leave Date.now
    // real: the limiter's lastRequestAt is module-level state shared across
    // tests, so a fully-resettable mocked clock would desync from it.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  /** Run one mocked lookup, advancing fake timers past the rate-limit queue. */
  async function geocodeWithMock(payload: unknown): Promise<unknown> {
    stubNominatimResponse(payload)
    const pending = geocodeViaNominatim("123 Fake St, Springfield")
    await vi.advanceTimersByTimeAsync(2_000)
    return pending
  }

  it("maps a valid hit to a GeocodeResult", async () => {
    const result = await geocodeWithMock([{ lat: "30.2241", lon: "-92.0198" }])
    expect(result).toEqual({ latitude: 30.2241, longitude: -92.0198, source: "nominatim" })
  })

  it("accepts boundary coordinates (-90/90 lat, -180/180 lng)", async () => {
    const result = await geocodeWithMock([{ lat: "-90", lon: "180" }])
    expect(result).toEqual({ latitude: -90, longitude: 180, source: "nominatim" })
  })

  it.each([
    ["null lat", [{ lat: null, lon: "-92.0198" }]],
    ["null lon", [{ lat: "30.2241", lon: null }]],
    ["empty-string lat", [{ lat: "", lon: "-92.0198" }]],
    ["whitespace-only lon", [{ lat: "30.2241", lon: "   " }]],
    ["non-numeric lat", [{ lat: "abc", lon: "-92.0198" }]],
    ["Infinity lat string", [{ lat: "Infinity", lon: "-92.0198" }]],
    ["latitude above 90", [{ lat: "91", lon: "-92.0198" }]],
    ["latitude below -90", [{ lat: "-90.5", lon: "-92.0198" }]],
    ["longitude above 180", [{ lat: "30.2241", lon: "181" }]],
    ["longitude below -180", [{ lat: "30.2241", lon: "-181" }]],
    ["numeric (non-string) lat", [{ lat: 30.2241, lon: "-92.0198" }]],
  ])("degrades to null for %s", async (_name, payload) => {
    expect(await geocodeWithMock(payload)).toBeNull()
  })
})
