import { randomUUID } from "node:crypto"

import { ConfigModule } from "@nestjs/config"
import { Test, type TestingModule } from "@nestjs/testing"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { DbModule } from "../../src/db/db.module.js"
import { DbService } from "../../src/db/db.service.js"
import { DigestRepository } from "../../src/notifications/digest.repository.js"
import { ReminderRepository } from "../../src/notifications/reminder.repository.js"
import { zonedDayStartUtc } from "../../src/pipeline/zoned-time.js"
import { ensureCatalogSchema, truncateCatalog } from "./catalog.js"
import { integrationDatabaseUrl } from "./db.js"

describe("notification repositories", () => {
  let moduleRef: TestingModule
  let db: DbService
  let digests: DigestRepository
  let reminders: ReminderRepository

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ DATABASE_URL: integrationDatabaseUrl(), NODE_ENV: "test" })],
        }),
        DbModule,
      ],
      providers: [DigestRepository, ReminderRepository],
    }).compile()
    db = moduleRef.get(DbService)
    digests = moduleRef.get(DigestRepository)
    reminders = moduleRef.get(ReminderRepository)
    await ensureCatalogSchema(db)
    await db.query(`
      CREATE TABLE IF NOT EXISTS public.user_notification_preferences (
        user_id uuid PRIMARY KEY,
        reminder_email boolean,
        digest_email boolean NOT NULL DEFAULT false
      )
    `)
  })

  beforeEach(async () => {
    await db.query("TRUNCATE public.user_notification_preferences")
    await truncateCatalog(db)
  })

  afterAll(async () => {
    await moduleRef.close()
  })

  it("finds opted-in published favorites with profiles and excludes opt-outs", async () => {
    const cityId = randomUUID()
    const userA = randomUUID()
    const userB = randomUUID()
    const userWithoutProfile = randomUUID()
    const start = zonedDayStartUtc(new Date("2026-08-16T16:00:00Z"), "America/Chicago", 0)
    const end = zonedDayStartUtc(new Date("2026-08-16T16:00:00Z"), "America/Chicago", 1)
    await db.query(
      `INSERT INTO public.cities (id, name, slug, timezone)
       VALUES ($1, 'Lafayette', 'lafayette', 'America/Chicago')`,
      [cityId]
    )
    await db.query(
      `INSERT INTO public.user_profiles (id, email, display_name)
       VALUES ($1, 'a@example.com', 'A'), ($2, 'b@example.com', 'B')`,
      [userA, userB]
    )
    await db.query(
      `INSERT INTO public.user_notification_preferences (user_id, reminder_email)
       VALUES ($1, false)`,
      [userB]
    )
    const published = randomUUID()
    const draft = randomUUID()
    await db.query(
      `INSERT INTO public.events
       (id, title, start_datetime, city_id, status, venue_name)
       VALUES
       ($1, 'Published', $3, $4, 'published', 'Library'),
       ($2, 'Draft', $3, $4, 'draft', 'Library')`,
      [published, draft, start.toISOString(), cityId]
    )
    await db.query(
      `INSERT INTO public.favorites (user_id, event_id) VALUES
       ($1, $4), ($2, $4), ($3, $4), ($1, $5)`,
      [userA, userB, userWithoutProfile, published, draft]
    )

    await expect(
      reminders.findReminderTargets({
        windowStart: start.toISOString(),
        windowEnd: end.toISOString(),
      })
    ).resolves.toEqual([
      expect.objectContaining({
        userId: userA,
        eventId: published,
        email: "a@example.com",
        reminderEmail: null,
      }),
    ])
  })

  it("keyset-lists email digest opt-ins with preferred-city fallback", async () => {
    const primaryCity = randomUUID()
    const extraCity = randomUUID()
    const optedIn = randomUUID()
    const optedOut = randomUUID()
    await db.query(
      `INSERT INTO public.cities (id, name, slug, timezone, latitude, longitude) VALUES
       ($1, 'Lafayette', 'lafayette', 'America/Chicago', 30.22, -92.02),
       ($2, 'Baton Rouge', 'baton-rouge', 'America/Chicago', 30.45, -91.19)`,
      [primaryCity, extraCity]
    )
    await db.query(
      `INSERT INTO public.user_profiles
       (id, email, display_name, city_preference_id, child_age) VALUES
       ($1, 'digest@example.com', 'Digest Reader', $3, 8),
       ($2, 'out@example.com', 'Opted Out', $3, 7)`,
      [optedIn, optedOut, primaryCity]
    )
    await db.query(
      `INSERT INTO public.user_notification_preferences (user_id, digest_email) VALUES
       ($1, true), ($2, false)`,
      [optedIn, optedOut]
    )
    await db.query(
      `INSERT INTO public.user_preferred_cities (user_id, city_id)
       VALUES ($1, $2)`,
      [optedIn, extraCity]
    )

    await expect(digests.listDigestUsers(null, 1000)).resolves.toEqual([
      {
        userId: optedIn,
        email: "digest@example.com",
        displayName: "Digest Reader",
        childAge: 8,
        cityName: "Lafayette",
        lat: 30.22,
        lng: -92.02,
        cityIds: [extraCity],
      },
    ])
    await expect(digests.listDigestUsers(optedIn, 1000)).resolves.toEqual([])
    await expect(digests.findDigestUserByEmail("DIGEST@example.com")).resolves.toMatchObject({
      userId: optedIn,
      cityIds: [extraCity],
    })
  })
})
