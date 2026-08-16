import { afterEach, describe, expect, it, vi } from "vitest"

import type { PlanRepository } from "../data/plan.repository.js"
import type { ReferenceRepository } from "../data/reference.repository.js"
import type { City } from "../data/types.js"
import { ConsumerService } from "./consumer.service.js"
import type { WeatherService } from "./weather.service.js"

const CITY: City = {
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  name: "Lafayette",
  state: "LA",
  slug: "lafayette",
  timezone: "America/Chicago",
  latitude: "30.22",
  longitude: "-92.02",
}

function makeService(opts?: { cities?: City[]; weatherFit?: string }): {
  service: ConsumerService
  planForRange: ReturnType<typeof vi.fn>
  snapshot: ReturnType<typeof vi.fn>
} {
  const planForRange = vi.fn(async () => [])
  const snapshot = vi.fn(async () => ({
    available: true,
    weatherFit: opts?.weatherFit ?? "outdoor",
    temperatureC: 21,
    condition: "Clear",
    observedAt: "2026-08-16T12:00:00.000Z",
  }))
  const service = new ConsumerService(
    {} as never,
    { listCities: async () => opts?.cities ?? [CITY] } as unknown as ReferenceRepository,
    { planForRange } as unknown as PlanRepository,
    { snapshot } as unknown as WeatherService
  )
  return { service, planForRange, snapshot }
}

afterEach(() => {
  vi.useRealTimers()
})

describe("ConsumerService.planForToday", () => {
  it("uses the app's D+0..1 window, limit 5, and weatherFit neutral without a city", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-16T12:00:00.000Z"))
    const { service, planForRange, snapshot } = makeService()

    await expect(service.planForToday({ cityId: null, kidAge: null }, "user-1")).resolves.toEqual({
      available: true,
      planned: [],
    })

    expect(snapshot).not.toHaveBeenCalled()
    expect(planForRange).toHaveBeenCalledWith({
      userKey: "user-1",
      dateFrom: "2026-08-16T12:00:00.000Z",
      dateTo: "2026-08-17T12:00:00.000Z",
      cityIds: null,
      lat: null,
      lng: null,
      kidAge: null,
      weatherFit: "neutral",
      limit: 5,
    })
  })

  it("threads city coords and weatherFit when the city has coordinates", async () => {
    const { service, planForRange, snapshot } = makeService({ weatherFit: "indoor" })
    await service.planForToday({ cityId: CITY.id, kidAge: 6 }, "user-1")
    expect(snapshot).toHaveBeenCalledWith(30.22, -92.02)
    expect(planForRange.mock.calls[0]?.[0]).toMatchObject({
      cityIds: [CITY.id],
      lat: 30.22,
      lng: -92.02,
      kidAge: 6,
      weatherFit: "indoor",
    })
  })
})
