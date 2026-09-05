# U30 Notify Family

## Decision

Keep `public.notification_queue` as the transactional durable buffer and the source of truth for the one-hour debounce. Event-change triggers already write this table in the same database transaction as event updates. Replacing each row with a delayed pg-boss job would split that transaction boundary, duplicate debounce state, and require a migration.

The notify pg-boss family provides only the polling clock and worker ownership. Its stable `process-notification-queue` schedule runs every five minutes and processes at most 100 eligible rows per run.

## Ownership and activation

This is a new internal schedule, not a replacement for a Railway cron label. Its family schedule has `replaces: null`, and `NotifyQueueService` does not call `CronGateService` or write legacy cron history.

Production activation requires `CUTOVER_NOTIFY="true"` followed by an API restart or redeploy. Until then, neither `notify` nor `notify.dlq` nor its worker is registered. Disabled bootstrap explicitly removes the durable `process-notification-queue` schedule, and the runtime handler fails closed if ownership is disabled. The worker uses `localConcurrency: 1` and `retryLimit: 0`.

Before activation:

1. Confirm `public.notification_queue`, `public.user_notifications`, and `public.user_notification_preferences` are present from the existing Supabase migrations.
2. Confirm the Resend template `family-events-event-change` exists and set `RESEND_API_KEY`, `RESEND_FROM`, and `APP_URL`.
3. Confirm both `ios` and `android` subscriptions contain current FCM tokens. Configure FCM and Web Push credentials in `vault.decrypted_secrets` or the matching environment fallback variables.
4. Confirm every stored Web Push endpoint is HTTPS on an approved provider host: exact `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `web.push.apple.com`, or a subdomain ending in `.notify.windows.com`.
5. Set `CUTOVER_NOTIFY="true"`, redeploy, and confirm one five-minute schedule is installed. No `private.cron_enabled` handoff is needed.

## Processing and failure semantics

Each run first acquires one namespaced, session-level PostgreSQL advisory lock, so only one process can own the table-backed delivery run. A worker that cannot acquire it returns a lock-not-acquired skip with no reads or delivery side effects. The owner selects at most 100 unprocessed rows older than one hour, ordered by `created_at` and `id`. Event, profile, and preference hydration must all succeed before email, in-app, or push delivery begins. A successfully missing preference row defaults `change_email` and `change_push` to true. Missing event, profile, or email data skips delivery and still participates in finalization.

Delivery remains before the final `processed_at` marker. This preserves the legacy no-automatic-retry tradeoff: delivery failures do not retry inside the job, while marker failure is returned as `ok: false`, `processed: 0`, and `persistenceFailed: true` without throwing because some side effects may already have occurred. A later scheduled run can redeliver rows whose marker failed, so marker failure creates a possible duplicate, not an at-most-once guarantee.

Finalization compares both the selected row ID and its selected `created_at` value. A trigger refresh that moves `created_at` after selection remains pending and is reported in the run's `refreshed` count.

In-app notifications use one bulk insert first, then isolated per-row inserts if the bulk statement fails. Push recipients are grouped by event and change type so one `PushService.send` call handles each identical payload. Push results distinguish unmatched recipients from subscription-level sent, failed, pruned, and skipped counts.

## Deferred

Direct APNs delivery is deferred until `push_subscriptions` has a provider discriminator and existing tokens have been migrated. The deployed contract currently stores FCM tokens for both iOS and Android. Reminder push and in-app delivery, plus Telegram digest delivery, also remain deferred U30 work. They are not registered or processed by this family.
