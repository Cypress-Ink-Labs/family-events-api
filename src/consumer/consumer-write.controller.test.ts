import { BadRequestException, HttpException } from "@nestjs/common"
import { Test } from "@nestjs/testing"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { ClerkAuthGuard } from "../auth/clerk.guard.js"
import { MappedIdentityGuard } from "../auth/mapped-identity.guard.js"
import { CalendarRepository } from "../data/calendar.repository.js"
import { CommentsRepository } from "../data/comments.repository.js"
import { FavoritesRepository } from "../data/favorites.repository.js"
import {
  PreferredCitiesRepository,
  PreferredCitiesValidationError,
} from "../data/preferred-cities.repository.js"
import { RatingsRepository } from "../data/ratings.repository.js"
import { SubmissionLimitError, SubmissionsRepository } from "../data/submissions.repository.js"
import { ConsumerWriteController } from "./consumer-write.controller.js"
import { parseCommunityEventInput } from "./consumer-write.input.js"
import { ConsumerWriteService } from "./consumer-write.service.js"

const USER_KEY = "99999999-9999-4999-8999-999999999999"
const EVENT_ID = "11111111-1111-4111-8111-111111111111"
const CITY_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const REQUEST = {
  identity: {
    clerkUserId: "user_reader",
    supabaseUuid: USER_KEY,
    email: "reader@example.com",
    role: "member" as const,
  },
}

describe("ConsumerWriteController", () => {
  const favorites = { addFavorite: vi.fn(), removeFavorite: vi.fn() }
  const calendar = { addToCalendar: vi.fn(), removeFromCalendar: vi.fn() }
  const ratings = { upsertEventRating: vi.fn() }
  const comments = { addEventComment: vi.fn(), deleteOwnComment: vi.fn() }
  const submissions = { submitCommunityEvent: vi.fn() }
  const preferredCities = { setPreferredCities: vi.fn(), listPreferredCities: vi.fn() }
  let controller: ConsumerWriteController

  beforeEach(async () => {
    vi.clearAllMocks()
    const builder = Test.createTestingModule({
      controllers: [ConsumerWriteController],
      providers: [
        ConsumerWriteService,
        { provide: FavoritesRepository, useValue: favorites },
        { provide: CalendarRepository, useValue: calendar },
        { provide: RatingsRepository, useValue: ratings },
        { provide: CommentsRepository, useValue: comments },
        { provide: SubmissionsRepository, useValue: submissions },
        { provide: PreferredCitiesRepository, useValue: preferredCities },
      ],
    })
    builder.overrideGuard(ClerkAuthGuard).useValue({ canActivate: () => true })
    builder.overrideGuard(MappedIdentityGuard).useValue({ canActivate: () => true })
    const moduleRef = await builder.compile()
    controller = moduleRef.get(ConsumerWriteController)
  })

  it("maps the typed submission limit error to 429", async () => {
    submissions.submitCommunityEvent.mockRejectedValueOnce(new SubmissionLimitError())

    const result = controller.submitEvent(
      {
        title: "Neighborhood Picnic",
        startDatetime: "2026-08-19T15:00:00+00:00",
        cityId: CITY_ID,
      },
      REQUEST
    )

    await expect(result).rejects.toSatisfy(
      (error: unknown) => error instanceof HttpException && error.getStatus() === 429
    )
  })

  it("maps preferred-city repository validation errors to 400", async () => {
    preferredCities.setPreferredCities.mockRejectedValueOnce(
      new PreferredCitiesValidationError("primary city must be selected")
    )

    const result = controller.setPreferredCities(
      { city_ids: [CITY_ID], primary_city_id: CITY_ID },
      REQUEST
    )

    await expect(result).rejects.toBeInstanceOf(BadRequestException)
  })

  it("rejects invalid ratings before calling the repository layer", async () => {
    expect(() => controller.rateEvent(EVENT_ID, { score: 6 }, REQUEST)).toThrow(BadRequestException)
    expect(ratings.upsertEventRating).not.toHaveBeenCalled()
  })

  it("rejects a preferred primary city outside the selected set", async () => {
    expect(() =>
      controller.setPreferredCities(
        {
          city_ids: [CITY_ID],
          primary_city_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        },
        REQUEST
      )
    ).toThrow(BadRequestException)
    expect(preferredCities.setPreferredCities).not.toHaveBeenCalled()
  })
})

describe("parseCommunityEventInput", () => {
  const validBody = {
    title: "Neighborhood Picnic",
    startDatetime: "2026-08-19T15:00:00+00:00",
    cityId: CITY_ID,
  }

  it("rejects endDatetime before startDatetime, naming the field", () => {
    const bad = {
      ...validBody,
      startDatetime: "2026-06-01T10:00:00Z",
      endDatetime: "2026-06-01T09:00:00Z",
    }
    try {
      parseCommunityEventInput(bad)
      expect.unreachable()
    } catch (error) {
      const response = (error as BadRequestException).getResponse() as {
        issues: Array<{ path: string; message: string }>
      }
      expect(response.issues.some((issue) => issue.path === "endDatetime")).toBe(true)
    }
  })

  it("rejects ageMin above ageMax, naming the field", () => {
    const bad = { ...validBody, ageMin: 12, ageMax: 5 }
    try {
      parseCommunityEventInput(bad)
      expect.unreachable()
    } catch (error) {
      const response = (error as BadRequestException).getResponse() as {
        issues: Array<{ path: string; message: string }>
      }
      expect(response.issues.some((issue) => issue.path === "ageMax")).toBe(true)
    }
  })

  it("caps keyword-length style overflow on title", () => {
    const bad = { ...validBody, title: "x".repeat(201) }
    expect(() => parseCommunityEventInput(bad)).toThrow(BadRequestException)
  })
})
