import { ConfigService } from "@nestjs/config"
import { describe, expect, it, vi } from "vitest"

import type { Env } from "../config/env.js"
import type { PlanRepository } from "../data/plan.repository.js"
import type { PlannedEvent } from "../data/types.js"
import type { DigestRepository, DigestUser } from "./digest.repository.js"
import { DigestService } from "./digest.service.js"
import type { MailService, SendMailInput, SendMailResult } from "./mail.service.js"

const user = (id: string): DigestUser => ({
  userId: id,
  email: `${id}@example.com`,
  displayName: id,
  childAge: 7,
  cityName: "Lafayette",
  lat: 30.22,
  lng: -92.02,
  cityIds: ["cccccccc-cccc-4ccc-8ccc-cccccccccccc"],
})

const plannedEvent: PlannedEvent = {
  event_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  score: "0.9",
  start_datetime: "2026-09-05T15:00:00.000Z",
  city_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  title: "Storytime",
  venue_name: "Library",
  address: null,
  is_free: true,
  price: null,
  images: [],
  distance_score: "0.9",
  timing_score: "0.8",
}

function makeService() {
  const repository = {
    listDigestUsers: vi.fn(async () => [] as DigestUser[]),
    findDigestUserByEmail: vi.fn(async () => null as DigestUser | null),
  }
  const plans = { planForRange: vi.fn(async () => [plannedEvent]) }
  const mail = {
    send: vi.fn(async (_input: SendMailInput): Promise<SendMailResult> => ({
      sent: true,
      status: 200,
    })),
  }
  const config = {
    get: (key: keyof Env) => (key === "APP_URL" ? "https://events.example.com" : undefined),
  } as ConfigService<Env, true>
  return {
    service: new DigestService(
      repository as unknown as DigestRepository,
      plans as unknown as PlanRepository,
      mail as unknown as MailService,
      config
    ),
    repository,
    plans,
    mail,
  }
}

describe("DigestService", () => {
  it("keyset-paginates until a short page", async () => {
    const { service, repository, plans } = makeService()
    const fullPage = Array.from({ length: 1000 }, (_, index) =>
      user(String(index).padStart(4, "0"))
    )
    repository.listDigestUsers.mockResolvedValueOnce(fullPage).mockResolvedValueOnce([user("last")])
    plans.planForRange.mockResolvedValue([])

    await service.processRun(new Date("2026-09-01T15:00:00Z"))

    expect(repository.listDigestUsers).toHaveBeenNthCalledWith(1, null, 1000)
    expect(repository.listDigestUsers).toHaveBeenNthCalledWith(2, "0999", 1000)
    expect(repository.listDigestUsers).toHaveBeenCalledTimes(2)
  })

  it("uses the upcoming Chicago weekend and all planner inputs", async () => {
    const { service, repository, plans } = makeService()
    repository.listDigestUsers.mockResolvedValueOnce([user("u1")])

    await service.processRun(new Date("2026-09-03T18:00:00Z"))

    expect(plans.planForRange).toHaveBeenCalledWith({
      userKey: "u1",
      dateFrom: "2026-09-04T05:00:00.000Z",
      dateTo: "2026-09-07T05:00:00.000Z",
      cityIds: ["cccccccc-cccc-4ccc-8ccc-cccccccccccc"],
      lat: 30.22,
      lng: -92.02,
      kidAge: 7,
      weatherFit: "neutral",
      limit: 5,
    })
  })

  it("starts at now once the weekend is underway", async () => {
    const { service, repository, plans } = makeService()
    repository.listDigestUsers.mockResolvedValueOnce([user("u1")])

    await service.processRun(new Date("2026-09-04T18:00:00Z"))

    expect(plans.planForRange).toHaveBeenCalledWith(
      expect.objectContaining({ dateFrom: "2026-09-04T18:00:00.000Z" })
    )
  })

  it("skips zero-event users without sending mail", async () => {
    const { service, repository, plans, mail } = makeService()
    repository.listDigestUsers.mockResolvedValueOnce([user("u1")])
    plans.planForRange.mockResolvedValueOnce([])

    await expect(service.processRun(new Date("2026-09-01T15:00:00Z"))).resolves.toEqual({
      emailed: 0,
      skipped: 1,
    })
    expect(mail.send).not.toHaveBeenCalled()
  })

  it("scopes a test run to one opted-in repository user without scanning pages", async () => {
    const { service, repository, mail } = makeService()
    repository.findDigestUserByEmail.mockResolvedValueOnce({
      ...user("u1"),
      email: "test@example.com",
    })

    await expect(
      service.processRun(new Date("2026-09-01T15:00:00Z"), " TEST@example.com ")
    ).resolves.toEqual({ emailed: 1, skipped: 0 })
    expect(repository.findDigestUserByEmail).toHaveBeenCalledWith("test@example.com")
    expect(repository.listDigestUsers).not.toHaveBeenCalled()
    expect(mail.send).toHaveBeenCalledWith({
      to: "test@example.com",
      subject: "1 family picks for your weekend",
      html: expect.any(String),
    })
    expect(mail.send.mock.calls[0]?.[0]).not.toHaveProperty("templateId")
  })
})
