import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { DbService } from "../db/db.service.js"
import { scheduledOperations } from "../pipeline/scheduled-operations.js"
import type {
  BrowserSubscriptionDto,
  NotificationPreferencesDto,
} from "../consumer/notification-preferences.dto.js"
import type {
  BrowserSubscriptionInputDto,
  NotificationPreferencesUpdateDto,
} from "../consumer/notification-preferences.dto.js"

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferencesDto = {
  reminder_email: true,
  reminder_push: true,
  change_email: true,
  change_push: true,
  digest_email: true,
  digest_push: false,
}
const FIELDS = "reminder_email, reminder_push, change_email, change_push, digest_email, digest_push"
type DeliveryFamily = "notify" | "reminders" | "digest"

@Injectable()
export class NotificationPreferencesRepository {
  constructor(private readonly db: DbService) {}

  async deliveryGates(): Promise<Record<DeliveryFamily, boolean>> {
    const schedules = scheduledOperations().filter(
      ({ family }) => family === "notify" || family === "reminders" || family === "digest"
    )
    const rows = await this.db.query<{ family: DeliveryFamily; enabled: boolean }>(
      `SELECT schedule.family,
        (schedule.legacy_label IS NULL OR NOT COALESCE(legacy.enabled,true))
          AND COALESCE(api.enabled,true) AS enabled
       FROM unnest($1::text[],$2::text[],$3::text[]) AS schedule(family,legacy_label,api_label)
       LEFT JOIN private.cron_enabled legacy ON legacy.label=schedule.legacy_label
       LEFT JOIN private.cron_enabled api ON api.label=schedule.api_label`,
      [
        schedules.map(({ family }) => family),
        schedules.map(({ replaces }) => replaces),
        schedules.map(({ gateLabel }) => gateLabel),
      ]
    )
    const gates: Record<DeliveryFamily, boolean> = {
      notify: false,
      reminders: false,
      digest: false,
    }
    for (const row of rows) gates[row.family] = row.enabled
    return gates
  }

  async get(userId: string): Promise<NotificationPreferencesDto> {
    const [row] = await this.db.query<NotificationPreferencesDto>(
      `SELECT ${FIELDS} FROM public.user_notification_preferences WHERE user_id = $1::uuid`,
      [userId]
    )
    return row ?? { ...DEFAULT_NOTIFICATION_PREFERENCES }
  }

  subscriptions(userId: string): Promise<BrowserSubscriptionDto[]> {
    return this.db.query<BrowserSubscriptionDto>(
      "SELECT id, endpoint FROM public.push_subscriptions WHERE user_id = $1::uuid AND platform = 'web' ORDER BY created_at, id",
      [userId]
    )
  }

  async update(userId: string, input: NotificationPreferencesUpdateDto): Promise<void> {
    await this.db.withTransaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('notifications:' || $1::text, 0))",
        [userId]
      )
      await client.query(
        "INSERT INTO public.user_notification_preferences(user_id) VALUES($1::uuid) ON CONFLICT(user_id) DO NOTHING",
        [userId]
      )
      const current = await client.query<NotificationPreferencesDto>(
        `SELECT ${FIELDS} FROM public.user_notification_preferences WHERE user_id = $1::uuid FOR UPDATE`,
        [userId]
      )
      if (input.digest_push === true && !current.rows[0]!.digest_push)
        throw new BadRequestException("Weekly digest browser push is not supported")
      if (input.reminder_push === true || input.change_push === true) {
        const subscription = await client.query(
          "SELECT id FROM public.push_subscriptions WHERE id = $2::uuid AND user_id = $1::uuid AND platform = 'web'",
          [userId, input.browser_subscription_id ?? null]
        )
        if (!subscription.rows.length)
          throw new BadRequestException("Register this browser before enabling push")
      }
      const entries = Object.entries(input).filter(
        ([field]) => field in DEFAULT_NOTIFICATION_PREFERENCES
      )
      const assignments = entries.map(([field], index) => `${field} = $${index + 2}`)
      const saved = await client.query<NotificationPreferencesDto>(
        `UPDATE public.user_notification_preferences SET ${assignments.join(", ")}, updated_at = now() WHERE user_id = $1::uuid RETURNING ${FIELDS}`,
        [userId, ...entries.map(([, value]) => value)]
      )
      if (!saved.rows[0]!.reminder_push && !saved.rows[0]!.change_push)
        await client.query(
          "DELETE FROM public.push_subscriptions WHERE user_id = $1::uuid AND platform = 'web'",
          [userId]
        )
    })
  }

  async register(
    userId: string,
    input: BrowserSubscriptionInputDto
  ): Promise<BrowserSubscriptionDto> {
    return this.db.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [input.endpoint])
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('notifications:' || $1::text, 0))",
        [userId]
      )
      const other = await client.query(
        "SELECT id FROM public.push_subscriptions WHERE endpoint = $1 AND user_id <> $2::uuid",
        [input.endpoint, userId]
      )
      if (other.rows.length)
        throw new ConflictException(
          "This browser subscription is linked to another account. Reset its subscription and try again."
        )
      const result = await client.query<BrowserSubscriptionDto>(
        `INSERT INTO public.push_subscriptions(user_id, platform, endpoint, p256dh, auth_key)
        VALUES($1::uuid, 'web', $2, $3, $4) ON CONFLICT(user_id, endpoint)
        DO UPDATE SET p256dh = EXCLUDED.p256dh, auth_key = EXCLUDED.auth_key, updated_at = now()
        RETURNING id, endpoint`,
        [userId, input.endpoint, input.p256dh, input.auth_key]
      )
      return result.rows[0]!
    })
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.db.withTransaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('notifications:' || $1::text, 0))",
        [userId]
      )
      const result = await client.query(
        "DELETE FROM public.push_subscriptions WHERE user_id = $1::uuid AND id = $2::uuid AND platform = 'web' RETURNING id",
        [userId, id]
      )
      if (!result.rows.length) throw new NotFoundException("Browser subscription not found")
    })
  }
}
