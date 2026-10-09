# Notification delivery readiness

Local evidence for [migration ticket #33](https://github.com/Cypress-Ink-Labs/family-events-app/issues/33), under [#25](https://github.com/Cypress-Ink-Labs/family-events-app/issues/25), recorded on 2026-10-08. The inspected API baseline is `274c2d1f3fbc60fe27655a8ecb5b0079646b64a4`.

The existing workers cover the required delivery paths. This ticket adds production flag-off registration checks and a real PostgreSQL event-change worker test with controlled provider outcomes. It changes no runtime behavior, flags, dependencies, schema, or provider configuration. No real recipients, provider credentials, production services, or production ownership state were inspected or used.

## Supported delivery paths

| Worker | Channels | Local evidence |
| --- | --- | --- |
| Reminders | Email, inbox, Web Push, FCM | `reminder.service.test.ts` and `reminder-hardening.test.ts` cover independent preferences, exact Chicago morning-of/day-before windows, payloads, missing providers, isolated failures, stable inbox IDs, replay, pacing, and cancellation. Real repository tests verify recipient selection and inbox persistence. |
| Weekly digest | Email and Telegram | `digest.service.test.ts`, `digest-hardening.test.ts`, and rendering tests cover independent opt-ins, Telegram-only recipients, empty plans, payloads, planner inputs, email-only test selection, failure isolation, pagination, pacing, and cancellation. Real repository tests verify preference constraints and recipient selection. |
| Event changes | Email, inbox, Web Push, FCM | `notification-queue.service.test.ts` covers the one-hour debounce, hydration failures before delivery, payloads, grouping, missing data, fallback inbox writes, and marker failures. Real worker tests exercise all four email/push preference combinations, provider unavailability, inbox persistence, queue finalization, and a second run with no redelivery. |

`digest_push` is a stored legacy preference, not an implemented digest delivery path. The app must not promise digest push based on that value. Both iOS and Android use FCM tokens; direct APNs remains deferred.

Provider-level fixtures independently verify Resend hosted-template and raw-HTML requests, Telegram HTML requests and Vault-first resolution, encrypted Web Push records and VAPID signatures, FCM OAuth assertions and platform payloads, trusted endpoints, missing configuration, bounded payloads, timeouts, cancellation, and expired-subscription pruning. They stub HTTP/DNS/provider responses and generate cryptographic keys in the tests; they do not contact providers. See `mail.service.test.ts`, `telegram.service.test.ts`, `push.service.test.ts`, and `push/*.test.ts`.

## Ownership and failure semantics

- Production reminder/digest queues register only for the exact string `"true"`. Added tests prove absent, `"false"`, and `"TRUE"` values install no queues or schedules. These are creation-time flags. For a running deployment, the `nestjs:<legacy label>` database gate is the operational pause control.
- Scheduled reminders/digests call `CronGateService`. A missing legacy gate defaults to legacy ownership; a true legacy gate or false Nest gate suppresses work. PostgreSQL tests verify those states and succeeded/failed run history. The reminder label is `cron-send-reminders`; the digest label is `cron-weekly-digest`. Rollout must validate actual ownership and any in-flight legacy work before transferring either schedule.
- Notify has an internal schedule, no legacy Railway label. Its fixture tests prove flag-off schedule removal and runtime rejection. Real PostgreSQL tests prove that a second queue runner cannot acquire the session advisory lock while one owns it.
- Preferences suppress external channels independently. Reminder and eligible event-change inbox entries remain available when email/push are disabled. Event changes preserve the existing behavior that a missing event, profile, or email skips every channel and finalizes the selected queue entry.
- Event-change delivery occurs before the durable processed marker. Marker failure reports `ok: false`, `processed: 0`, and `persistenceFailed: true`; a later run can duplicate prior delivery. This is not an at-most-once guarantee. A queue entry refreshed after selection remains pending. Ordinary channel failures still finalize entries without automatic delivery retries.
- Reminder inbox IDs remain stable across replay. External provider acceptance is separate from inbox persistence and does not prove end-device or inbox receipt. Queue summaries preserve recipient counts, subscription counts, failures, prunes, skips, and unknown batch outcomes separately.

## Verification

Executed with Node 24.18.0 and repository-pinned pnpm 10.33.3. Use this prefix on this host:

```sh
PNPM_HOME=/home/lecoqjacob/.local/share/pnpm npm_config_manage_package_manager_versions=false corepack pnpm
```

- Before additions, the notification/provider/flag/family/CronGate/Jobs unit selection passed **27 files / 241 tests**.
- After additions, the complete API unit/HTTP fixture suite passed **139 files / 1,565 tests** via `pnpm test`.
- `notifications.integration.test.ts` and `cron-gate.integration.test.ts` passed **2 files / 19 tests** against an owned disposable `pgvector/pgvector:pg17` container on loopback port **55441**. The shared developer port 55322 was never used. The repository fixture catalog uses `user_profiles` as its user FK target because it has no Supabase `auth.users` table; it preserves notification constraints, indexes, and triggers. This is not the complete frozen-bootstrap migration rehearsal.
- `build`, `format:check`, `lint`, `typecheck`, and `git diff --check` passed. Lint retains existing warnings outside the changed tests. `pnpm check` could not invoke its nested pnpm commands because the host shim selects pnpm 12.8.1; its constituent checks were invoked separately through the pinned Corepack command and passed.

Integration command, with `DATABASE_URL` pointing only to the owned disposable database:

```sh
corepack pnpm exec vitest run --config vitest.integration.config.mts \
  test/integration/notifications.integration.test.ts \
  test/integration/cron-gate.integration.test.ts
```

## Separate rollout prerequisites

1. Refresh actual production flags, deployed notification tables/triggers, queues, schedules, legacy ownership gates, and in-flight work. Repository deployment notes are historical evidence, not current production verification. Keep the single-writer transfer and rollback for reminders and digest explicit.
2. Provision the Resend hosted templates `family-events-event-reminder` and `family-events-event-change`, a verified sender, and the intended `APP_URL`. Digest uses raw HTML. Credentials and template existence remain unverified.
3. Validate VAPID credentials/subject, supported Web Push endpoints and real subscriptions, and FCM service-account configuration with current iOS/Android FCM registration tokens. Validate the Telegram bot and opted-in recipient chat IDs. Missing provider configuration should remain a channel skip rather than a false delivery promise.
4. Obtain separate approval for actual credentials, deployment/flags/ownership changes, and messages to controlled recipients. A manual digest `{ "task": "test", "testEmail": "..." }` remains email-only and requires an existing email opt-in; it does not test Telegram or push. Reminder/event-change delivery does not have an equivalent one-recipient selector, so a production trial needs an explicitly isolated recipient/data procedure before execution.
5. Finish app preference/subscription/inbox workflows and API transport migration, the transactional invitation-email replacement, and the final frozen-bootstrap migration/rollback rehearsal under their separate tickets. No browser notification enrollment or authenticated account journey is claimed by this worker evidence.

No production flags were enabled, no messages sent, and no deployment or issue closure performed by this ticket.
