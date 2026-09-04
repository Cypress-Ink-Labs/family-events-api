import { randomUUID } from "node:crypto"

import { ConfigModule } from "@nestjs/config"
import { Test, type TestingModule } from "@nestjs/testing"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { DbModule } from "../../src/db/db.module.js"
import { DbService } from "../../src/db/db.service.js"
import { DigestRepository } from "../../src/notifications/digest.repository.js"
import { NotificationQueueRepository } from "../../src/notifications/notification-queue.repository.js"
import { ReminderRepository } from "../../src/notifications/reminder.repository.js"
import { zonedDayStartUtc } from "../../src/pipeline/zoned-time.js"
import { ensureCatalogSchema, truncateCatalog } from "./catalog.js"
import { integrationDatabaseUrl } from "./db.js"

describe("notification repositories", () => {
  let moduleRef: TestingModule
  let db: DbService
  let digests: DigestRepository
  let reminders: ReminderRepository
  let notificationQueue: NotificationQueueRepository

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
      providers: [DigestRepository, NotificationQueueRepository, ReminderRepository],
    }).compile()
    db = moduleRef.get(DbService)
    digests = moduleRef.get(DigestRepository)
    reminders = moduleRef.get(ReminderRepository)
    notificationQueue = moduleRef.get(NotificationQueueRepository)
    await ensureCatalogSchema(db)
    await db.query(`
      CREATE TABLE IF NOT EXISTS public.user_notification_preferences (
        user_id uuid PRIMARY KEY,
        reminder_email boolean,
        digest_email boolean NOT NULL DEFAULT false,
        change_email boolean NOT NULL DEFAULT true,
        change_push boolean NOT NULL DEFAULT true
      )
    `)
    await db.query(
      "ALTER TABLE public.user_notification_preferences ADD COLUMN IF NOT EXISTS change_email boolean NOT NULL DEFAULT true"
    )
    await db.query(
      "ALTER TABLE public.user_notification_preferences ADD COLUMN IF NOT EXISTS change_push boolean NOT NULL DEFAULT true"
    )
    await db.query("DROP TABLE IF EXISTS public.user_notifications, public.notification_queue")
    await db.query(`
      CREATE TABLE public.notification_queue (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
        event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
        change_type text NOT NULL,
        change_detail jsonb,
        processed boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        processed_at timestamptz
      )
    `)
    await db.query(`
      CREATE TABLE public.user_notifications (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
        type text NOT NULL,
        title text NOT NULL,
        body text NOT NULL,
        event_id uuid REFERENCES public.events(id) ON DELETE SET NULL,
        read_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
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

  it("filters, hydrates, inserts, and marks durable notification queue rows", async () => {
    const cityId = randomUUID()
    const userId = randomUUID()
    const eventId = randomUUID()
    const pendingId = randomUUID()
    const freshId = randomUUID()
    const processedId = randomUUID()
    await db.query(
      `INSERT INTO public.cities (id, name, slug, timezone)
       VALUES ($1, 'Lafayette', $2, 'America/Chicago')`,
      [cityId, `lafayette-${cityId}`]
    )
    await db.query(
      `INSERT INTO public.user_profiles (id, email, display_name)
       VALUES ($1, 'notify@example.com', 'Notify Reader')`,
      [userId]
    )
    await db.query(
      `INSERT INTO public.events (id, title, start_datetime, city_id, status, venue_name)
       VALUES ($1, 'Changed Event', '2026-09-06T16:30:00Z', $2, 'published', 'Library')`,
      [eventId, cityId]
    )
    await db.query(
      `INSERT INTO public.user_notification_preferences
       (user_id, change_email, change_push) VALUES ($1, false, true)`,
      [userId]
    )
    await db.query(
      `INSERT INTO public.notification_queue
       (id, user_id, event_id, change_type, change_detail, processed, created_at, processed_at)
       VALUES
       ($1, $4, $5, 'time_changed', '{"new_start":"2026-09-06T16:30:00Z"}', false,
        '2026-09-05T13:00:00Z', null),
       ($2, $4, $5, 'venue_changed', '{}', false, '2026-09-05T14:30:00Z', null),
       ($3, $4, $5, 'cancelled', '{}', true, '2026-09-05T12:00:00Z',
        '2026-09-05T12:30:00Z')`,
      [pendingId, freshId, processedId, userId, eventId]
    )

    await expect(notificationQueue.listPending("2026-09-05T14:00:00.000Z")).resolves.toEqual([
      expect.objectContaining({
        id: pendingId,
        userId,
        eventId,
        changeType: "time_changed",
        changeDetail: { new_start: "2026-09-06T16:30:00Z" },
      }),
    ])
    await expect(notificationQueue.hydrateEvents([eventId, eventId])).resolves.toEqual([
      expect.objectContaining({ id: eventId, title: "Changed Event", venueName: "Library" }),
    ])
    await expect(notificationQueue.hydrateProfiles([userId])).resolves.toEqual([
      { id: userId, email: "notify@example.com", displayName: "Notify Reader" },
    ])
    await expect(notificationQueue.hydratePreferences([userId])).resolves.toEqual([
      { userId, changeEmail: false, changePush: true },
    ])

    await notificationQueue.insertInAppNotifications([
      {
        userId,
        type: "change",
        title: "Updated: Changed Event",
        body: "The event time has changed.",
        eventId,
      },
    ])
    await expect(
      db.query<{ title: string }>("SELECT title FROM public.user_notifications")
    ).resolves.toEqual([{ title: "Updated: Changed Event" }])

    const processedAt = "2026-09-05T15:00:00.000Z"
    await notificationQueue.markProcessed([pendingId, pendingId], processedAt)
    await expect(
      db.query<{ processed: boolean; processedAt: string | null }>(
        `SELECT processed, processed_at AS "processedAt"
         FROM public.notification_queue WHERE id = $1`,
        [pendingId]
      )
    ).resolves.toEqual([{ processed: true, processedAt: expect.any(String) }])
  })
})
