import { randomUUID } from "node:crypto"

import { ConfigModule } from "@nestjs/config"
import { Test, type TestingModule } from "@nestjs/testing"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { DbModule } from "../../src/db/db.module.js"
import { DbService } from "../../src/db/db.service.js"
import { DigestRepository } from "../../src/notifications/digest.repository.js"
import { NotificationQueueRepository } from "../../src/notifications/notification-queue.repository.js"
import { PushRepository } from "../../src/notifications/push.repository.js"
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
  let pushSubscriptions: PushRepository

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
      providers: [
        DigestRepository,
        NotificationQueueRepository,
        PushRepository,
        ReminderRepository,
      ],
    }).compile()
    db = moduleRef.get(DbService)
    digests = moduleRef.get(DigestRepository)
    reminders = moduleRef.get(ReminderRepository)
    notificationQueue = moduleRef.get(NotificationQueueRepository)
    pushSubscriptions = moduleRef.get(PushRepository)
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
    await db.query(
      "DROP TABLE IF EXISTS public.user_notifications, public.notification_queue, public.push_subscriptions"
    )
    await db.query("CREATE SCHEMA IF NOT EXISTS private")
    // The disposable API catalog has no auth.users table. user_profiles is the
    // local user FK target; checks, indexes, and trigger behavior match production.
    await db.query(`
      CREATE TABLE public.notification_queue (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
        event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
        change_type text NOT NULL CHECK (change_type IN (
          'time_changed', 'venue_changed', 'cancelled', 'status_changed'
        )),
        change_detail jsonb DEFAULT '{}'::jsonb,
        processed boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        processed_at timestamptz
      )
    `)
    await db.query(`
      CREATE UNIQUE INDEX notification_queue_dedup_idx
        ON public.notification_queue (user_id, event_id, change_type)
        WHERE processed = false
    `)
    await db.query(`
      CREATE INDEX notification_queue_pending_idx
        ON public.notification_queue (processed, created_at)
        WHERE processed = false
    `)
    await db.query(
      "CREATE INDEX notification_queue_user_id_idx ON public.notification_queue (user_id)"
    )
    await db.query(`
      CREATE OR REPLACE FUNCTION private.notify_event_changes()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path TO ''
      AS $$
      DECLARE
        v_change_type text;
        v_change_detail jsonb;
      BEGIN
        IF OLD.status != 'published' AND NEW.status NOT IN ('archived', 'rejected') THEN
          RETURN NEW;
        END IF;
        IF OLD.status = 'published' AND NEW.status IN ('archived', 'rejected') THEN
          v_change_type := 'cancelled';
          v_change_detail := jsonb_build_object(
            'old_status', OLD.status, 'new_status', NEW.status
          );
        ELSIF OLD.start_datetime IS DISTINCT FROM NEW.start_datetime
          OR OLD.end_datetime IS DISTINCT FROM NEW.end_datetime THEN
          v_change_type := 'time_changed';
          v_change_detail := jsonb_build_object(
            'old_start', OLD.start_datetime, 'new_start', NEW.start_datetime,
            'old_end', OLD.end_datetime, 'new_end', NEW.end_datetime
          );
        ELSIF OLD.venue_name IS DISTINCT FROM NEW.venue_name
          OR OLD.address IS DISTINCT FROM NEW.address THEN
          v_change_type := 'venue_changed';
          v_change_detail := jsonb_build_object(
            'old_venue', OLD.venue_name, 'new_venue', NEW.venue_name,
            'old_address', OLD.address, 'new_address', NEW.address
          );
        ELSE
          RETURN NEW;
        END IF;
        INSERT INTO public.notification_queue (user_id, event_id, change_type, change_detail)
        SELECT favorites.user_id, NEW.id, v_change_type, v_change_detail
        FROM public.favorites
        WHERE favorites.event_id = NEW.id
        ON CONFLICT (user_id, event_id, change_type) WHERE processed = false
        DO UPDATE SET change_detail = EXCLUDED.change_detail, created_at = now();
        RETURN NEW;
      END;
      $$
    `)
    await db.query(`
      CREATE TRIGGER trg_notify_event_changes
        AFTER UPDATE ON public.events
        FOR EACH ROW
        EXECUTE FUNCTION private.notify_event_changes()
    `)
    await db.query(`
      CREATE TABLE public.user_notifications (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
        type text NOT NULL CHECK (type IN ('reminder', 'change', 'digest', 'system')),
        title text NOT NULL,
        body text NOT NULL,
        event_id uuid REFERENCES public.events(id) ON DELETE SET NULL,
        read_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `)
    await db.query(`
      CREATE INDEX user_notifications_user_created_idx
        ON public.user_notifications (user_id, created_at DESC)
    `)
    await db.query(`
      CREATE OR REPLACE FUNCTION private.cap_user_notifications()
      RETURNS trigger
      LANGUAGE plpgsql
      SET search_path TO ''
      AS $$
      BEGIN
        DELETE FROM public.user_notifications
        WHERE id IN (
          SELECT id FROM public.user_notifications
          WHERE user_id = NEW.user_id
          ORDER BY created_at DESC
          OFFSET 100
        );
        RETURN NEW;
      END;
      $$
    `)
    await db.query(`
      CREATE TRIGGER trg_cap_user_notifications
        AFTER INSERT ON public.user_notifications
        FOR EACH ROW
        EXECUTE FUNCTION private.cap_user_notifications()
    `)
    await db.query(`
      CREATE TABLE public.push_subscriptions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
        platform text NOT NULL CHECK (platform IN ('web', 'ios', 'android')),
        endpoint text,
        token text,
        p256dh text,
        auth_key text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT push_subscriptions_web_unique
          UNIQUE NULLS NOT DISTINCT (user_id, endpoint),
        CONSTRAINT push_subscriptions_mobile_unique
          UNIQUE NULLS NOT DISTINCT (user_id, token),
        CONSTRAINT push_subscriptions_platform_fields CHECK (
          CASE
            WHEN platform = 'web'
              THEN endpoint IS NOT NULL AND p256dh IS NOT NULL AND auth_key IS NOT NULL
            ELSE token IS NOT NULL
          END
        )
      )
    `)
    await db.query(
      "CREATE INDEX push_subscriptions_user_id_idx ON public.push_subscriptions (user_id)"
    )
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

    const selected = await notificationQueue.listPending("2026-09-05T14:00:00.000Z")
    expect(selected).toEqual([
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
    await expect(notificationQueue.markProcessed(selected, processedAt)).resolves.toBe(1)
    await expect(
      db.query<{ processed: boolean; processedAt: string | null }>(
        `SELECT processed, processed_at AS "processedAt"
         FROM public.notification_queue WHERE id = $1`,
        [pendingId]
      )
    ).resolves.toEqual([{ processed: true, processedAt: expect.any(String) }])
  })

  it("allows only one notification queue worker to hold the session lock", async () => {
    let releaseFirst!: () => void
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let firstStarted!: () => void
    const firstDidStart = new Promise<void>((resolve) => {
      firstStarted = resolve
    })

    const first = notificationQueue.withExclusiveRun(async () => {
      firstStarted()
      await firstMayFinish
      return "first"
    })
    await firstDidStart

    await expect(notificationQueue.withExclusiveRun(async () => "second")).resolves.toEqual({
      acquired: false,
    })
    releaseFirst()
    await expect(first).resolves.toEqual({ acquired: true, value: "first" })
  })

  it("does not finalize a queue row refreshed after selection", async () => {
    const cityId = randomUUID()
    const userId = randomUUID()
    const eventId = randomUUID()
    const queueId = randomUUID()
    await db.query(
      `INSERT INTO public.cities (id, name, slug, timezone)
       VALUES ($1, 'Lafayette', $2, 'America/Chicago')`,
      [cityId, `lafayette-${cityId}`]
    )
    await db.query("INSERT INTO public.user_profiles (id, email) VALUES ($1, 'race@example.com')", [
      userId,
    ])
    await db.query(
      `INSERT INTO public.events (id, title, start_datetime, city_id, status)
       VALUES ($1, 'Race Event', '2026-09-06T16:30:00Z', $2, 'published')`,
      [eventId, cityId]
    )
    await db.query(
      `INSERT INTO public.notification_queue
       (id, user_id, event_id, change_type, created_at)
       VALUES ($1, $2, $3, 'time_changed', '2026-09-05T13:00:00Z')`,
      [queueId, userId, eventId]
    )
    const selected = await notificationQueue.listPending("2026-09-05T14:00:00Z")
    await db.query(
      "UPDATE public.notification_queue SET created_at = '2026-09-05T13:30:00Z' WHERE id = $1",
      [queueId]
    )

    await expect(notificationQueue.markProcessed(selected, "2026-09-05T15:00:00Z")).resolves.toBe(0)
    await expect(
      db.query<{ processed: boolean }>(
        "SELECT processed FROM public.notification_queue WHERE id = $1",
        [queueId]
      )
    ).resolves.toEqual([{ processed: false }])
  })

  it("lists production-shaped push subscriptions and prunes selected IDs", async () => {
    const userId = randomUUID()
    const webId = randomUUID()
    const iosId = randomUUID()
    await db.query("INSERT INTO public.user_profiles (id, email) VALUES ($1, 'push@example.com')", [
      userId,
    ])
    await db.query(
      `INSERT INTO public.push_subscriptions
       (id, user_id, platform, endpoint, p256dh, auth_key)
       VALUES ($1, $2, 'web', 'https://fcm.googleapis.com/send/fixture', 'key', 'auth')`,
      [webId, userId]
    )
    await db.query(
      `INSERT INTO public.push_subscriptions (id, user_id, platform, token)
       VALUES ($1, $2, 'ios', 'fcm-ios-token')`,
      [iosId, userId]
    )

    const subscriptions = await pushSubscriptions.listSubscriptions([userId, userId])
    expect(subscriptions).toHaveLength(2)
    expect(subscriptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: webId, platform: "web", userId }),
        expect.objectContaining({ id: iosId, platform: "ios", token: "fcm-ios-token", userId }),
      ])
    )

    await pushSubscriptions.deleteExpiredSubscriptions([iosId, iosId])
    await expect(
      db.query<{ id: string }>("SELECT id FROM public.push_subscriptions ORDER BY id")
    ).resolves.toEqual([{ id: webId }])
  })
})
