import { Injectable, Logger } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"

import type { Env } from "../config/env.js"

export type WeatherFit = "outdoor" | "indoor" | "any"

export interface WeatherSnapshot {
  available: boolean
  weatherFit: WeatherFit | "neutral"
  temperatureC: number | null
  condition: string | null
  observedAt: string | null
}

const OPENWEATHER_ENDPOINT = "https://api.openweathermap.org/data/2.5/weather"
const UPSTREAM_TIMEOUT_MS = 5_000

const UNAVAILABLE: WeatherSnapshot = {
  available: false,
  weatherFit: "neutral",
  temperatureC: null,
  condition: null,
  observedAt: null,
}

export function weatherFitFromConditions(
  condition: string | null,
  temperatureC: number | null
): WeatherFit {
  if (!condition) return "any"

  const lower = condition.toLowerCase()
  if (
    lower.includes("rain") ||
    lower.includes("storm") ||
    lower.includes("snow") ||
    lower.includes("drizzle") ||
    lower.includes("ash") ||
    lower.includes("tornado")
  ) {
    return "indoor"
  }

  if (temperatureC != null && (temperatureC <= 0 || temperatureC >= 33)) {
    return "indoor"
  }

  return "outdoor"
}

function isValidLat(value: number): boolean {
  return Number.isFinite(value) && value >= -90 && value <= 90
}

function isValidLon(value: number): boolean {
  return Number.isFinite(value) && value >= -180 && value <= 180
}

/**
 * OpenWeatherMap proxy (U26). Missing key, bad coords, or upstream failure
 * return a neutral snapshot so plan ranking still runs.
 */
@Injectable()
export class WeatherService {
  private readonly logger = new Logger(WeatherService.name)

  constructor(private readonly config: ConfigService<Env, true>) {}

  async snapshot(lat: number, lon: number): Promise<WeatherSnapshot> {
    if (!isValidLat(lat) || !isValidLon(lon)) return UNAVAILABLE

    const apiKey = this.config.get("OPENWEATHER_API_KEY", { infer: true })
    if (!apiKey) return UNAVAILABLE

    const upstream = new URL(OPENWEATHER_ENDPOINT)
    upstream.searchParams.set("lat", String(lat))
    upstream.searchParams.set("lon", String(lon))
    upstream.searchParams.set("appid", apiKey)
    upstream.searchParams.set("units", "metric")

    try {
      const response = await fetch(upstream, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      })
      if (!response.ok) return UNAVAILABLE

      const payload: unknown = await response.json()
      return parseWeatherPayload(payload)
    } catch (error) {
      this.logger.warn(
        `weather unavailable: ${error instanceof Error ? error.message : "unknown error"}`
      )
      return UNAVAILABLE
    }
  }
}

function parseWeatherPayload(payload: unknown): WeatherSnapshot {
  if (payload === null || typeof payload !== "object") return UNAVAILABLE
  const record = payload as Record<string, unknown>
  const weather = Array.isArray(record.weather) ? record.weather[0] : undefined
  const main = record.main !== null && typeof record.main === "object" ? record.main : undefined
  const condition =
    weather !== null &&
    typeof weather === "object" &&
    typeof (weather as { main?: unknown }).main === "string"
      ? (weather as { main: string }).main
      : null
  const temperatureC =
    main !== undefined && typeof (main as { temp?: unknown }).temp === "number"
      ? (main as { temp: number }).temp
      : null
  const observedAt = typeof record.dt === "number" ? new Date(record.dt * 1000).toISOString() : null
  return {
    available: true,
    condition,
    temperatureC,
    observedAt,
    weatherFit: weatherFitFromConditions(condition, temperatureC),
  }
}
