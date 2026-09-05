# Deployment (family-events-api)

Railway service, railpack build (`railway.toml`), Node 22 (`NODE_VERSION=22`
service variable). Healthcheck: `GET /healthz` (liveness, no DB). `GET /readyz`
pings the database.

Authoritative variable list: `src/config/env.ts` (zod-validated at boot) plus
the pipeline's `process.env` seams noted below. `.env.example` mirrors both.

## Service variables

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string. Cutover: the shared Supabase Postgres (session pooler URL). Local dev uses `127.0.0.1:55322`. Boot fails without it. |
| `CLERK_SECRET_KEY` | yes in production | Clerk secret key (`sk_...`). Fail-closed: guarded routes report unauthenticated when unset. |
| `NODE_ENV` | yes | `production`. Cutover flags require exact `"true"` in production (`src/pipeline/flags.ts`). |
| `PORT` | no | Defaults to 3001; Railway injects its own. |
| `PGBOSS_SCHEMA` | no | pg-boss schema, default `pgboss`. Must match the U12 worker so both share one job store. |
| `WEB_ORIGIN` | no | Public origin of the web app (e.g. `https://<app>.up.railway.app`). Enables CORS with credentials for browser calls; unset = no CORS headers. |
| `CUTOVER_SCRAPE` / `CUTOVER_TAG` / `CUTOVER_REVIEW` / `CUTOVER_DIGEST` / `CUTOVER_REMINDERS` / `CUTOVER_NOTIFY` | no | Per-job-family cutover flags; all default off (nothing installed). Set to exact `"true"` per family only during the U33 migration window. |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_FAILURE_CHAT_ID` | no | Operator failure pings (U3). Both required to send; unset is a silent no-op. |
| `OPENWEATHER_API_KEY` | no | `GET /v1/plan` weather ranking. Unset degrades to a neutral snapshot. |
| `AI_PROVIDER` / `AI_BASE_URL` / `AI_MODEL` / `AI_API_KEY` / `OPENAI_API_KEY` | no | LLM extraction fallback, tagging, review, and embeddings (`src/pipeline/llm-config.ts`; `OPENAI_API_KEY` also read directly by tag-event embeddings). Unset leaves LLM paths unconfigured. |
| `UNSPLASH_ACCESS_KEY` / `PEXELS_API_KEY` / `PIXABAY_API_KEY` | no | Stock-image enrichment (U29); unset providers are skipped in fallback order. Unsplash key is shared by search, download tracking, and attribution backfill. |
| `SCRAPER_IMAGE_HOST_ALLOWLIST` | no | Comma-separated extra ingest image hosts appended to the built-in CDN allowlist. |
| `VAPID_PRIVATE_KEY` / `VAPID_PUBLIC_KEY` / `VAPID_SUBJECT` | required for web push | Environment fallback for Web Push credentials. Vault names `vapid_private_key`, `vapid_public_key`, and `vapid_subject` take precedence. |
| `FCM_SERVICE_ACCOUNT_JSON` | required for mobile push | JSON service account fallback for FCM HTTP v1. Both iOS and Android subscription tokens use FCM. Vault name `fcm_service_account_json` takes precedence. |
| `NODE_VERSION` | yes | `22` — Railway service variable, not a `.env` entry. |

Note: the `AI_*`, stock-image, and allowlist variables are read through
`process.env` seams in pipeline code rather than the zod schema; they are
intentionally absent from `src/config/env.ts`.

## Deploy flow (operator)

1. Create/link the Railway service to this repo (git integration, `main` branch).
2. Set the service variables above. Never paste secrets into files or chat.
3. First deploy: verify `/healthz` returns 200 and `/readyz` returns 200 (DB reachable).
4. Smoke: `GET /v1/events` returns events from the shared database.
5. After the app service exists, set `WEB_ORIGIN` to its public URL and redeploy.

## After cutover (informational)

pg-boss schedules replace the legacy Railway cron containers stage by stage
(rewrite plan U33): enabling a `CUTOVER_<FAMILY>` flag installs the family's
queues, and the atomic `private.cron_enabled` handoff disables the matching
legacy label. Both sides must never run the same schedule simultaneously.

## Notifications (email, staged)

In production, queues register only when their cutover flags are exactly
`"true"`: `CUTOVER_REMINDERS` and `CUTOVER_DIGEST`. Scheduled handlers also
pass through the atomic `private.cron_enabled` gate, so setting a flag installs
the queue but sends nothing until the corresponding legacy cron is disabled.

| Variable | Required when enabled | Notes |
| --- | --- | --- |
| `RESEND_API_KEY` | yes | Resend key. Unset means all email soft-fails (logged as `sent: false, dev: true`); jobs still complete without retry. |
| `RESEND_FROM` | recommended | Default `Family Events <onboarding@resend.dev>` is a sandbox sender; replace it with a verified domain for production. |
| `APP_URL` | recommended | Default `https://family-events.up.railway.app`; used for event, logo, browse, and preference links. |

Operator checklist before flipping a flag:

1. Confirm the Resend hosted template `family-events-event-reminder` exists.
   Legacy templates were deployed outside the repository, so recreate it if
   needed. The weekly digest uses raw HTML and needs no hosted template.
2. Set `RESEND_FROM` to a verified Resend domain.
3. Set `CUTOVER_DIGEST="true"` and redeploy to install the queue, but leave the
   legacy digest cron enabled. Scheduled `send` jobs remain blocked by the
   ownership gate.
4. Submit a one-recipient job through the pg-boss dashboard or SQL:
   `{ "task": "test", "testEmail": "you@example.com" }`. Manual `test` jobs
   bypass only the schedule-ownership gate; the address must belong to a user
   with `digest_email = true`.
5. Disable the matching legacy cron through the U33 atomic handoff, then watch
   the first scheduled run summary. Repeat independently for reminders.

## Event-change notification queue

`CUTOVER_NOTIFY` installs an internal five-minute pg-boss schedule. It does not
replace a Railway cron and does not use `CronGateService`. The existing
`public.notification_queue` table remains the durable one-hour debounce buffer.
When the flag is off, bootstrap removes the durable `process-notification-queue`
schedule if a prior deployment installed it. The runtime handler also rejects
work while the flag is off.

Checklist before setting `CUTOVER_NOTIFY="true"`:

1. Confirm the existing notification queue, preference, in-app notification,
   and push subscription tables are deployed. No new API migration is required.
2. Create the Resend hosted template `family-events-event-change`, then set
   `RESEND_API_KEY`, a verified `RESEND_FROM`, and `APP_URL`.
3. Confirm every `ios` and `android` row in `public.push_subscriptions` contains
   a current FCM registration token. Direct APNs tokens are not supported.
4. Confirm stored Web Push endpoints use HTTPS and one of the trusted provider
   hosts: `fcm.googleapis.com`, `updates.push.services.mozilla.com`,
   `web.push.apple.com`, or a subdomain of `notify.windows.com`.
5. Add Web Push and FCM credentials to `vault.decrypted_secrets`, or set the
   environment fallback variables listed above. Missing provider credentials
   soft-skip only that provider.
6. Set `CUTOVER_NOTIFY="true"` and redeploy. Confirm `notify`, `notify.dlq`, and
   one `process-notification-queue` schedule exist with concurrency 1 and no retries.
7. Do not create or disable a `private.cron_enabled` label for notify. Monitor the
   first run counts, lock skips, refreshed rows, unmatched push recipients, and
   any `persistenceFailed` result.

Direct APNs delivery remains deferred until the schema has a provider
discriminator and existing tokens have been migrated. Reminder push and in-app
delivery, plus Telegram digest delivery, also remain deferred.
