import { ConfigService } from "@nestjs/config"
import { afterEach, describe, expect, it, vi } from "vitest"

import { WeatherService, weatherFitFromConditions } from "./weather.service.js"

function makeService(apiKey?: string): WeatherService {
  const config = new ConfigService({ OPENWEATHER_API_KEY: apiKey })
  return new WeatherService(config as unknown as ConfigService<never, true>)
}

function mockWeatherOk(body: unknown): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("weatherFitFromConditions", () => {
  it("maps precipitation and extremes to indoor, otherwise outdoor", () => {
    expect(weatherFitFromConditions(null, 20)).toBe("any")
    expect(weatherFitFromConditions("Rain", 18)).toBe("indoor")
    expect(weatherFitFromConditions("Thunderstorm", 22)).toBe("indoor")
    expect(weatherFitFromConditions("Clear", -1)).toBe("indoor")
    expect(weatherFitFromConditions("Clear", 33)).toBe("indoor")
    expect(weatherFitFromConditions("Clear", 22)).toBe("outdoor")
  })
})

describe("WeatherService.snapshot", () => {
  it("returns a neutral snapshot when the API key is unset", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    await expect(makeService(undefined).snapshot(30.22, -92.02)).resolves.toEqual({
      available: false,
      weatherFit: "neutral",
      temperatureC: null,
      condition: null,
      observedAt: null,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("returns a neutral snapshot for invalid coordinates without fetching", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    await expect(makeService("key").snapshot(91, 0)).resolves.toMatchObject({ available: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("fetches OpenWeatherMap and maps the snapshot", async () => {
    const fetchMock = mockWeatherOk({
      weather: [{ main: "Clear" }],
      main: { temp: 21.4 },
      dt: 1_700_000_000,
    })
    vi.stubGlobal("fetch", fetchMock)

    await expect(makeService("owm-key").snapshot(30.22, -92.02)).resolves.toEqual({
      available: true,
      weatherFit: "outdoor",
      temperatureC: 21.4,
      condition: "Clear",
      observedAt: new Date(1_700_000_000 * 1000).toISOString(),
    })

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit]
    expect(url.origin + url.pathname).toBe("https://api.openweathermap.org/data/2.5/weather")
    expect(url.searchParams.get("lat")).toBe("30.22")
    expect(url.searchParams.get("lon")).toBe("-92.02")
    expect(url.searchParams.get("appid")).toBe("owm-key")
    expect(url.searchParams.get("units")).toBe("metric")
    expect(init.headers).toEqual({ Accept: "application/json" })
  })

  it("never throws when upstream fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down")
      })
    )
    await expect(makeService("key").snapshot(30.22, -92.02)).resolves.toMatchObject({
      available: false,
      weatherFit: "neutral",
    })
  })

  it("treats a non-OK upstream status as unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 429,
        json: async () => ({ message: "nope" }),
      }))
    )
    await expect(makeService("key").snapshot(30.22, -92.02)).resolves.toMatchObject({
      available: false,
    })
  })
})
