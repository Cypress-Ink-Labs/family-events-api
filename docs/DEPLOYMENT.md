# Deployment (family-events-api)

Railway service, railpack build (`railway.toml`), Node 24 or newer
(`NODE_VERSION=24` service variable). Healthcheck: `GET /healthz`
(liveness, no DB). `GET /readyz` pings the database.

Authoritative variable list: `src/config/env.ts` (zod-validated at boot) plus
the pipeline's `process.env` seams noted below. `.env.example` mirrors both.

## Current Railway deployment

Project `family-events` (`35ac6425-4859-4203-bbd4-15744209e717`) contains two
production services sourced from `Cypress-Ink-Labs/family-events-api` on
`main`:

- API service `295c57ed-a8f7-4405-a54b-1a2893296eec` at
  `https://api-production-ecb3.up.railway.app`;
- dashboard service `a3ccab3c-7743-4876-ad26-649653a337e8` at
  `https://pgboss-dashboard-production-36fd.up.railway.app`.

The API health and readiness endpoints return 200. The dashboard requires
built-in Basic Auth, permits authenticated reads, and rejects mutation methods
with 403. It connects over Railway IPv6 to the Supabase direct endpoint using
the dedicated `pgboss_dashboard` login and the pinned Supabase CA. That login
has no pg-boss write privileges.

U33 has transferred the scrape, tag, and review families:

- `CUTOVER_SCRAPE=true`;
- `cron-scrape-sources=false` and `cron-cleanup-stale=false` in one transaction;
- `scrape` and `scrape.dlq` are installed with the hourly scrape and 30-minute
  cleanup schedules;
- controlled scrape and cleanup runs succeeded, the drain chain completed, and
  no scrape DLQ work remained;
- `CUTOVER_TAG=true`;
- `cron-tag-queue=false` and `cron-enrich-events=false` in one transaction;
- controlled and scheduled tag/enrichment runs succeeded after OpenAI and
  Unsplash credential smokes, and no tag DLQ work remained;
- `CUTOVER_REVIEW=true` with batch size 60;
- `cron-review-events=false`;
- the exact `gpt-5.4-mini` JSON-mode request passed, a single prioritized draft
  review completed with consistent queue/event/trace state, and eight catch-up
  runs drained the 377-row eligible backlog without failures or review DLQ work.

`CUTOVER_DIGEST`, `CUTOVER_REMINDERS`, and `CUTOVER_NOTIFY` remain disabled.
They require delivery credentials and identified controlled recipients before
their first production sends. The former Railway cron services have zero
running replicas. Database maintenance remains outside the Nest job families.

## Service variables

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string. Cutover: the shared Supabase Postgres (session pooler URL). Local dev uses `127.0.0.1:55322`. Boot fails without it. |
| `CLERK_SECRET_KEY` | yes in production | Clerk secret key (`sk_...`). Fail-closed: guarded routes report unauthenticated when unset. |
| `NODE_ENV` | yes | `production`. Cutover flags require exact `"true"` in production (`src/pipeline/flags.ts`). |
| `PORT` | no | Defaults to 3001; Railway injects its own. |
| `PGBOSS_SCHEMA` | no | pg-boss schema, default `pgboss`. Must match the U12 worker so both share one job store. |
| `WEB_ORIGIN` | no | Public origin of the web app (e.g. `https://<app>.up.railway.app`). Enables CORS with credentials for browser calls; unset = no CORS headers. |
| `SENTRY_DSN` | no | Enables Sentry error reporting when non-empty. Empty or absent disables SDK initialization and all sending. Do not commit the DSN. |
| `SENTRY_ENVIRONMENT` / `SENTRY_RELEASE` | no | Optional event labels used only when Sentry is enabled. |
| `SENTRY_TRACES_SAMPLE_RATE` | no | Trace sampling from 0 through 1; defaults to 0 (tracing disabled). Has no effect when `SENTRY_DSN` is unset. |
| `CUTOVER_SCRAPE` / `CUTOVER_TAG` / `CUTOVER_REVIEW` / `CUTOVER_DIGEST` / `CUTOVER_REMINDERS` / `CUTOVER_NOTIFY` | no | Per-job-family cutover flags; all default off (nothing installed). Set to exact `"true"` per family only during the U33 migration window. |
| `TELEGRAM_BOT_TOKEN` | required for Telegram digest | Environment fallback for digest delivery; Vault name `telegram_bot_token` takes precedence. Also shared with operator failure pings. |
| `TELEGRAM_FAILURE_CHAT_ID` | no | Operator destination for pipeline failure pings (U3). Never used for user digests. |
| `OPENWEATHER_API_KEY` | no | `GET /v1/plan` weather ranking. Unset degrades to a neutral snapshot. |
| `AI_PROVIDER` / `AI_BASE_URL` / `AI_MODEL` / `AI_API_KEY` / `OPENAI_API_KEY` | no | LLM extraction fallback, tagging, review, and embeddings (`src/pipeline/llm-config.ts`; `OPENAI_API_KEY` also read directly by tag-event embeddings). Unset leaves LLM paths unconfigured. |
| `UNSPLASH_ACCESS_KEY` / `PEXELS_API_KEY` / `PIXABAY_API_KEY` | no | Stock-image enrichment (U29); unset providers are skipped in fallback order. Unsplash key is shared by search, download tracking, and attribution backfill. |
| `SCRAPER_IMAGE_HOST_ALLOWLIST` | no | Comma-separated extra ingest image hosts appended to the built-in CDN allowlist. |
| `VAPID_PRIVATE_KEY` / `VAPID_PUBLIC_KEY` / `VAPID_SUBJECT` | required for web push | Environment fallback for Web Push credentials. Vault names `vapid_private_key`, `vapid_public_key`, and `vapid_subject` take precedence. |
| `FCM_SERVICE_ACCOUNT_JSON` | required for mobile push | JSON service account fallback for FCM HTTP v1. Both iOS and Android subscription tokens use FCM. Vault name `fcm_service_account_json` takes precedence. |
| `NODE_VERSION` | yes | `24` or newer. Railway service variable, not a `.env` entry. |

Note: the `AI_*`, stock-image, and allowlist variables are read through
`process.env` seams in pipeline code rather than the zod schema; they are
intentionally absent from `src/config/env.ts`.

## pg-boss dashboard service

Run `@pg-boss/dashboard@1.7.0` as a separate Railway service from this
repository. Build with the normal project build command, then start it with:

```text
pnpm start:dashboard
```

The startup wrapper exits before loading the dashboard unless Node is 24 or
newer and all of these service variables pass validation:

- `DATABASE_URL`: a separately credentialed URL for the same Supabase database
  and session-pooler endpoint used by the API;
- `PGBOSS_SCHEMA=pgboss`;
- non-empty, distinct `PGBOSS_DASHBOARD_AUTH_USERNAME` and
  `PGBOSS_DASHBOARD_AUTH_PASSWORD` values;
- `PGBOSS_DASHBOARD_READ_ONLY=1`;
- `HOST=0.0.0.0`;
- `NODE_EXTRA_CA_CERTS=/app/certs/supabase-prod-ca-2021.crt` when the dedicated
  login uses Supabase's direct endpoint;
- Railway's injected `PORT`.

Do not copy the API's credential-bearing `DATABASE_URL` into this service.
Create a dedicated database login with `CONNECT`, `USAGE` on the `pgboss`
schema, and `SELECT` on the pg-boss tables used by dashboard views. The pinned
dashboard starts pg-boss with schema creation, migration, scheduling, and
supervision disabled. Do not grant DDL or job-mutation privileges to the
dashboard login.

The committed Supabase Root 2021 CA comes from Supabase's published
`prod-ca-2021.crt`. Its SHA-256 fingerprint is
`80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`.
Verify that fingerprint against the certificate downloaded from the Supabase
project before replacing or rotating the file. Keep TLS hostname verification
enabled; do not use `NODE_TLS_REJECT_UNAUTHORIZED=0` or `sslmode=no-verify`.

Read-only middleware permits only `GET` and `HEAD`; it rejects every other HTTP
method before route handling. Built-in Basic Auth still protects all requests.
Expose the service only over Railway TLS. The package documents no health
endpoint, so do not configure a guessed HTTP health path. Use process or TCP
health until an explicit proxy/health design is approved.

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

## Scheduled reminders and digest (staged)

In production, queues register only when their cutover flags are exactly
`"true"`: `CUTOVER_REMINDERS` and `CUTOVER_DIGEST`. Scheduled handlers also
pass through the atomic `private.cron_enabled` gate, so setting a flag installs
the queue but sends nothing until the corresponding legacy cron is disabled.

| Variable | Required when enabled | Notes |
| --- | --- | --- |
| `RESEND_API_KEY` | yes | Resend key. Unset means all email soft-fails (logged as `sent: false, dev: true`); jobs still complete without retry. |
| `RESEND_FROM` | recommended | Default `Family Events <onboarding@resend.dev>` is a sandbox sender; replace it with a verified domain for production. |
| `APP_URL` | recommended | Default `https://family-events.up.railway.app`; used for event, logo, browse, and preference links. |
| `TELEGRAM_BOT_TOKEN` | yes for Telegram digest | Vault value `telegram_bot_token` takes precedence over this environment fallback. Missing token or per-user chat ID skips only Telegram. |
| Web Push / FCM credentials | yes for reminder push | Use the VAPID and FCM variables or Vault names listed above. Missing provider credentials skip only that provider. |

Active U30 channels are reminder email, in-app, Web Push, and FCM; weekly digest
email and Telegram; and event-change email, in-app, Web Push, and FCM. Both iOS
and Android use FCM registration tokens. Only direct APNs delivery is deferred.

Scheduled reminders use deterministic batches of 10 with a 300ms abortable delay
between batches. Digests use batches of 5 with a 500ms abortable delay between
batches, counting empty-plan users and continuing across 1,000-row page boundaries.
Neither flow delays after its last batch. Each channel fails independently.
Reminder in-app rows use stable IDs and upsert counts; one push context caches
subscriptions and credentials throughout the run.

Both scheduled queues explicitly set and reconcile `expireInSeconds = 43200`
(12 hours), with no retries. For 1,000 recipients and two serial 10-second provider
calls each, the provider budget is 20,000 seconds, plus 29.7 seconds of reminder
pacing or 99.5 seconds of digest pacing. These bounds fit below 12 hours and the
24-hour reminder interval; database work and additional push subscriptions add
runtime. Job cancellation propagates through queue handlers, pacing, Resend,
Web Push, FCM delivery/OAuth, and Telegram, combined with each provider's
10-second timeout. Cancellation fails the run instead of reporting completion.

The scheduled digest lazily resolves its validated, Vault-first Telegram token
at the first Telegram recipient, caching that result for the run. Email-only
runs do not look up Telegram credentials. Vault query waiting is bounded to
2 seconds; timeout or database failure permits the environment fallback, while
job cancellation propagates. The service retains its five-minute token cache; missing or invalid tokens
are not cached. A transient Vault failure permits the environment fallback.
Push delivery deduplicates and chunks recipient lookups at 1,000 IDs, continues
after a failed lookup chunk, and reports `failedBatches`/`failedBatchRecipients`
separately from subscription delivery failures. Complete Web Push and FCM JSON
payloads are bounded to 3,000 UTF-8 bytes without splitting Unicode code points.

Operator checklist before flipping a flag:

1. Confirm the Resend hosted template `family-events-event-reminder` exists.
   Legacy templates were deployed outside the repository, so recreate it if
   needed. The weekly digest uses raw HTML and needs no hosted template.
2. Set `RESEND_FROM` to a verified Resend domain. Configure VAPID/FCM for
   reminder push and `telegram_bot_token` in Vault (or `TELEGRAM_BOT_TOKEN`)
   for Telegram digest.
3. Set `CUTOVER_DIGEST="true"` and redeploy to install the queue, but leave the
   legacy digest cron enabled. Scheduled `send` jobs remain blocked by the
   ownership gate.
4. Submit a one-recipient job through the pg-boss dashboard or SQL:
   `{ "task": "test", "testEmail": "you@example.com" }`. Manual `test` jobs
   bypass only the schedule-ownership gate; the address must belong to a user
   with `digest_email = true`. Test-email jobs are intentionally email-only
   and never resolve a Telegram token, send to a stored Telegram chat, or apply
   scheduled batch delays.
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
discriminator and existing tokens have been migrated. The deployed iOS and
Android subscription contract uses FCM.
