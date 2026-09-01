# Email Notifications Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the two cron-driven email flows, day-before + morning-of reminders and the weekly digest, from the legacy edge functions to pg-boss jobs in this API, using Resend with legacy parity (no retry on user-facing sends, `America/Chicago`, same schedules, same Resend template id, same digest subject).

**Architecture:** The `reminders` and `digest` families already exist in `src/pipeline/families.ts` with the legacy cron expressions (`0 11 * * *`, `0 13 * * 1`) but no queue service registers them. This plan adds a `src/notifications/` module that follows the `scrape-queue.service.ts` pattern (`OnModuleInit` + `JobsService.registerQueue`, gated by `isFamilyEnabled` on `CUTOVER_REMINDERS` / `CUTOVER_DIGEST`), a soft-fail Resend client (`MailService`, plain `fetch`, never throws when `RESEND_API_KEY` is unset, mirroring legacy `_shared/resend.ts`), and SQL in repositories. Legacy business rules carry over exactly: no persistent dedup (in-run Set only, `retryLimit: 0` instead of the legacy `MAX_ATTEMPTS=1`), reminders window = zone-local today/tomorrow, digest window = zone-local Fri 00:00..Mon 00:00 with `from = max(now, friday)`.

**Tech Stack:** pg-boss 12 (installed), Resend HTTP API via `fetch` (no new dependency), NestJS 11, vitest (swc), pnpm.

**Spec:** Decisions locked 2026-08-31: email-first (push/Telegram deferred), pg-boss cron in this API. Legacy sources of truth: `family-events-backend/supabase/functions/send-reminders/index.ts`, `.../send-weekly-digest/index.ts`, cron schedules in `family-events-backend/.railway/railway.ts:51-98`. Rewrite plan U30 (this covers only its email slice). Baseline commit: `4dbaa42`. The executor MUST read the two legacy functions end to end before Task 2/3; line references below are anchors, and if the legacy file no longer matches them, re-locate the logic and note the drift.

## Global Constraints

- All commands from the api repo root. Gate: `pnpm check` after every task; `pnpm vitest run <file>` while iterating.
- Style: semicolons, double quotes, ESM `.js` import specifiers.
- `JobsService` skips everything under `NODE_ENV=test`, so queue registration is invisible to unit tests; handlers must be thin wrappers over testable service methods.
- SQL lives in `src/notifications/*.repository.ts` (consumer convention); services never concatenate SQL.
- Never log or commit secret values; env names only in `.env.example`.
- All SQL here reads shared legacy tables (`favorites`, `user_profiles`, `user_notification_preferences`) and the `plan_events_for_user_range` RPC. No schema changes, no writes to legacy tables in this plan.

---

### Task 1: `MailService` (soft-fail Resend client) + env + module skeleton

Legacy contract (`supabase/functions/_shared/resend.ts` + `resend-config.ts`): POST `https://api.resend.com/emails`, 10s timeout, never throws, returns `{ ok, status, errorBody? }`; unset `RESEND_API_KEY` means log + skip. Defaults: `RESEND_FROM` = `"Family Events <onboarding@resend.dev>"`, `APP_URL` = `"https://family-events.up.railway.app"`.

**Files:**
- Create: `src/notifications/notifications.module.ts`, `src/notifications/mail.service.ts`, `src/notifications/mail.service.test.ts`
- Modify: `src/config/env.ts` (+3 optional vars), `src/config/env.test.ts`, `.env.example`, `src/app.module.ts`

**Interfaces:**
- Produces: `MailService.send(input: { to: string; subject: string; html?: string; templateId?: string; variables?: Record<string, string> }): Promise<{ sent: boolean; dev?: boolean; status?: number }>`. Exactly one of `html` / `templateId` per call (template calls pass `variables`; Resend hosted-template shape: `{ from, to, subject, template: { id, variables } }` — copy the exact request body shape from legacy `sendResendEmail` call sites in `send-reminders/index.ts:267-282` and `notify-email/index.ts`).

- [ ] **Step 1: Env fields**

Add to `src/config/env.ts` (optional strings, matching the existing optional-field style) and mirror in `.env.example` with placeholder values and the comment `# legacy parity defaults exist in code; set for production`:

- `RESEND_API_KEY`
- `RESEND_FROM` (no default in the schema; the service applies the legacy default)
- `APP_URL` (same)

Add one env test case: schema parses with the three present and without them.

- [ ] **Step 2: Failing tests for MailService**

`src/notifications/mail.service.test.ts`. Use `vi.stubGlobal("fetch", mockFetch)` (restore in `afterEach`) and a `ConfigService` stub returning `RESEND_API_KEY`/`RESEND_FROM`/`APP_URL` (or `undefined` for the unset case):

```ts
  it("posts the hosted-template payload to Resend with a 10s timeout", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "em_1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const mail = makeMailService({ resendApiKey: "re_test", resendFrom: FROM, appUrl: APP_URL });

    const result = await mail.send({
      to: "user@example.com",
      subject: "Reminder",
      templateId: "family-events-event-reminder",
      variables: { USERNAME: "Reader" },
    });

    expect(result).toEqual({ sent: true, status: 200 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(init.body));
    expect(body.from).toBe(FROM);
    expect(body.to).toBe("user@example.com");
    expect(body.template).toMatchObject({ id: "family-events-event-reminder" });
  });

  it("soft-fails without an API key: no fetch, sent:false, dev:true", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const mail = makeMailService({ resendApiKey: undefined, resendFrom: FROM, appUrl: APP_URL });

    const result = await mail.send({ to: "user@example.com", subject: "s", html: "<p>x</p>" });

    expect(result).toEqual({ sent: false, dev: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns sent:false on a Resend error status and never throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 422 })));
    const mail = makeMailService({ resendApiKey: "re_test", resendFrom: FROM, appUrl: APP_URL });

    await expect(
      mail.send({ to: "user@example.com", subject: "s", html: "<p>x</p>" })
    ).resolves.toMatchObject({ sent: false, status: 422 });
  });

  it("maps network/timeout failures to sent:false", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("timeout");
    }));
    const mail = makeMailService({ resendApiKey: "re_test", resendFrom: FROM, appUrl: APP_URL });

    await expect(
      mail.send({ to: "user@example.com", subject: "s", html: "<p>x</p>" })
    ).resolves.toMatchObject({ sent: false });
  });
```

Run: `pnpm vitest run src/notifications/mail.service.test.ts` — FAIL (module missing).

- [ ] **Step 3: Implement MailService**

`src/notifications/mail.service.ts`: injectable, constructor takes `ConfigService`; timeout via `AbortSignal.timeout(10_000)`; wrap everything after the unset-key check in try/catch; log failures with `Logger` at warn (message shape from legacy: warn + skip). Assert `html`/`templateId` exclusivity with a guard that throws `Error` (programmer error, not runtime).

- [ ] **Step 4: Module + wiring**

`src/notifications/notifications.module.ts`: `@Module({ imports: [DataModule], providers: [MailService], exports: [MailService] })` (mirror `consumer.module.ts`'s import choices; add queue services/providers in Tasks 2-3). Register `NotificationsModule` in `src/app.module.ts` after `PipelineModule`.

Run: `pnpm vitest run src/notifications/mail.service.test.ts && pnpm check`
Expected: pass.

```bash
git add src/notifications src/config/env.ts src/config/env.test.ts .env.example src/app.module.ts
git commit -m "feat: soft-fail Resend MailService and notifications module skeleton"
```

---

### Task 2: Reminders queue (day-before + morning-of)

Legacy flow (`send-reminders/index.ts`, read it first): one daily run at `0 11 * * *`; windows `[zonedDayStartUtc(now, TZ, 0), +1)` (morning-of) and `[+1, +2)` (day-before) with `REMINDER_TZ = "America/Chicago"`; recipients = favorites joined to published events in-window and `user_profiles` (inner-join semantics: no profile, no email, no send); prefs from `user_notification_preferences.reminder_email` default true; in-run dedup Set `${user_id}:${event_id}:${type}`; per-target Resend hosted template `family-events-event-reminder` with vars `USERNAME, EVENT_TITLE, EVENT_DATE, EVENT_LOCATION, EVENT_URL, LOGO_URL, APP_URL`; no retry (legacy `MAX_ATTEMPTS=1`).

**Files:**
- Create: `src/notifications/reminder.repository.ts`, `src/notifications/reminder.service.ts`, `src/notifications/reminder.service.test.ts`, `src/notifications/reminder-queue.service.ts`
- Modify: `src/notifications/notifications.module.ts`
- Integration test: `test/integration/notifications.integration.test.ts` (new)

**Interfaces:**
- `ReminderRepository.findReminderTargets(input: { windowStart: string; windowEnd: string }): Promise<ReminderTarget[]>` where `ReminderTarget = { userId: string; email: string; displayName: string | null; eventId: string; title: string; startDatetime: string; venueName: string | null; address: string | null; reminderEmail: boolean | null }`.
- `ReminderService.processRun(now: Date): Promise<{ emailed: number; skipped: number }>` — called by the pg-boss handler; unit-tested.
- `ReminderQueueService` — `OnModuleInit`, gated by `isFamilyEnabled("reminders", process.env)`, registers DLQ (`handler: null`) + main queue with FAMILIES options but `retryLimit: 0` (U30 no-retry; legacy cron-runner `MAX_ATTEMPTS=1`), schedule from `FAMILIES.reminders.schedules` with `data: { task: "send" }`.

- [ ] **Step 1: Repository + SQL**

`src/notifications/reminder.repository.ts`, single query (direct SQL replaces legacy's separate PostgREST calls; the `!inner` join semantics become inner joins, prefs become a LEFT JOIN so missing rows default to opted-in):

```sql
SELECT
  f.user_id, f.event_id, p.email, p.display_name,
  e.title, e.start_datetime, e.venue_name, e.address,
  unp.reminder_email
FROM public.favorites f
JOIN public.events e ON e.id = f.event_id
  AND e.status = 'published'
  AND e.start_datetime >= $1
  AND e.start_datetime < $2
JOIN public.user_profiles p ON p.id = f.user_id
LEFT JOIN public.user_notification_preferences unp ON unp.user_id = f.user_id
ORDER BY f.user_id, e.start_datetime, e.id
```

- [ ] **Step 2: Unit tests for the service**

`src/notifications/reminder.service.test.ts` with mocked repository + MailService. Before writing expectations, read `send-reminders/index.ts:141-149` and `267-282` for the exact `EVENT_DATE`/`EVENT_LOCATION` formatting (Intl options + timezone) and transcribe them into the test comments. Test cases:

1. Two windows are queried: `processRun(new Date("2026-08-16T16:00:00Z"))` calls `findReminderTargets` with `[2026-08-16T05:00:00.000Z, 2026-08-17T05:00:00.000Z)` and `[2026-08-17T05:00:00.000Z, 2026-08-18T05:00:00.000Z)` (Chicago CDT) — pin the exact ISO strings after implementing (zonedDayStartUtc from `../pipeline/zoned-time.js` is proven; assert the two calls' args exactly).
2. Same user+event in both windows (favorite on an event today AND a second window row) dedups within the run via the `${userId}:${eventId}:${type}` Set (seed overlapping rows; assert one send).
3. `reminder_email === false` target produces no send and counts as skipped; `null` (no prefs row) sends.
4. Each send calls MailService with the template id, the seven legacy variables, `to` = profile email; a `LOGO_URL` value ported from the legacy constant (find it in the legacy file; if absent, `APP_URL + "/logo.png"` per the legacy call site).
5. MailService `sent: false` (soft-fail) never throws and still counts as attempted (log-only), matching legacy fire-and-forget.

Run to green.

- [ ] **Step 3: Queue service**

`src/notifications/reminder-queue.service.ts` — copy the structure of `src/pipeline/ingestion/scrape-queue.service.ts:55-91` (DLQ + main queue + schedule mapping); handler dispatches on `data.task === "send"` to `reminderService.processRun(new Date())`. Log a summary line (`emailed`, `skipped`) per run (legacy logs per-batch; one summary is the pg-boss-appropriate equivalent). Register in `notifications.module.ts` providers.

- [ ] **Step 4: Integration test for the SQL**

`test/integration/notifications.integration.test.ts` following `test/integration/consumer.integration.test.ts`'s harness (ConfigModule load with `integrationDatabaseUrl()`, DbModule + DataModule; you only need `DbService`, no HTTP app). Seed: city, `auth.users` row + `user_profiles` (email, display_name) for user A; user B with a `user_notification_preferences` row `reminder_email = false`; user C with favorites but NO profile row; one published event today-ish in-window (compute the window with `zonedDayStartUtc` in the test) and one draft event. Assert `findReminderTargets` returns exactly A's row (B excluded by pref filter `AND (unp.reminder_email IS NOT FALSE)` in the WHERE clause — add it; C excluded by the inner join), and the draft event is excluded.

Run: `pnpm vitest run src/notifications && pnpm test && pnpm check`, then `pnpm test:integration` with the database up.

```bash
git add src/notifications test/integration/notifications.integration.test.ts
git commit -m "feat: daily reminder emails as a pg-boss reminders queue"
```

---

### Task 3: Weekly digest queue

Legacy flow (`send-weekly-digest/index.ts`, read it first): Mondays `0 13 * * 1`; keyset-paged scan of `user_notification_preferences` (`digest_email = true` OR `digest_telegram`, 1000/page, cursor `user_id >` last; email-first port: only `digest_email = true` recipients); hydrate `user_profiles` (email, display_name, child_age, city) skipping users without email or city; optional `user_preferred_cities` else primary city; window `weekendWindowUtc(now, "America/Chicago")` with `from = max(now, friday)`; per-user `plan_events_for_user_range` via the existing plan repository (`PlanRepository.planForRange({ userKey, dateFrom, dateTo, cityIds, lat, lng, kidAge, weatherFit: "neutral", limit: 5 })` — confirm the exact method name in `src/data/plan.repository.ts` and adapt); skip users with zero events; subject `${events.length} family picks for your weekend`; email = RAW inline HTML (legacy renders it in-function because Resend template variables cap at 2,000 chars; do NOT switch to a hosted template); `buildExplanation` renders the top-2 score factors > 0.5 as `"nearby · perfect weekend timing"`-style strings.

**Files:**
- Create: `src/notifications/digest.repository.ts`, `src/notifications/digest.service.ts`, `src/notifications/digest.service.test.ts`, `src/notifications/digest-html.ts`, `src/notifications/digest-html.test.ts`, `src/notifications/digest-queue.service.ts`
- Modify: `src/notifications/notifications.module.ts`

**Interfaces:**
- `DigestRepository.listDigestUsers(after: string | null, limit: number): Promise<DigestUser[]>` where `DigestUser = { userId: string; email: string; displayName: string | null; childAge: number | null; cityName: string; lat: number | null; lng: number | null; cityIds: string[] }` (one query: prefs filtered to `digest_email IS TRUE`, joins to profiles + cities, plus a second query for `user_preferred_cities` batched as legacy does, fallback `city_preference_id`).
- `renderDigestEmail(input): { subject: string; html: string }` — pure.
- `buildExplanation(row): string | null` — pure, ported.
- `DigestService.processRun(now: Date, testEmail?: string): Promise<{ emailed: number; skipped: number }>`.

- [ ] **Step 1: Port the pure rendering pieces**

`src/notifications/digest-html.ts`: port `renderDigestHtml` + the Dusk-Meadow token constants from `send-weekly-digest/index.ts:109-348` verbatim, adapting only: escape helpers (use the legacy `escapeHtml` from `_shared/html.ts`, ported), `appUrl`/`logoUrl` injected as parameters (no env reads inside pure code), and TypeScript types. Port `buildExplanation` from lines 183-197, keeping the legacy factor keys and labels exactly as the source has them (transcribe them into `digest-html.test.ts` expectations and quote the source lines in a comment; if the source's factor names differ from this plan's example, THE SOURCE WINS).

`digest-html.test.ts`: fixed input (3 events with titles/dates/venues, factor rows) → assert subject `${n} family picks for your weekend`, html contains each title, the unsubscribe link is `${appUrl}/profile?tab=notifications`, and `<script` / unescaped `<` from title inputs do not appear (feed a title with `<script>` and assert it is escaped).

- [ ] **Step 2: Service tests**

`src/notifications/digest.service.test.ts` with mocked repository + plan repository + MailService:

1. Pagination: repository returns pages keyed by `after`; service loops until a short page (assert `listDigestUsers` called with ascending cursors and stops after the short page).
2. Window: `planForRange` receives `dateFrom = max(now, fridayStart)`, `dateTo = mondayStart`, `weatherFit: "neutral"`, `limit: 5`, `kidAge: childAge`, `cityIds` from the user row. Use `vi.setSystemTime` mid-week (e.g. Thursday) so `max()` bites, and once on a Friday.
3. Zero-event users are skipped (no MailService call) and counted in `skipped`.
4. `testEmail` scopes the run: when provided, repository is bypassed for a single synthetic user row with that email (legacy lines 510-527 semantics; assert exactly one send and no `listDigestUsers` call).
5. Each send: MailService with `html` (NOT `templateId`), legacy subject, `to` = user email.

- [ ] **Step 3: Queue service**

`src/notifications/digest-queue.service.ts` — scrape-queue pattern for the `digest` family; `retryLimit: 0` (legacy no-retry label); schedule data `{ task: "send" }`; handler also accepts `{ task: "send", testEmail?: string }` for operator test runs; schedule `key: "weekly-digest"` (stable key so redeploys do not duplicate schedules; pg-boss upserts by key). Register in the module.

- [ ] **Step 4: Verify and commit**

Run: `pnpm vitest run src/notifications && pnpm test && pnpm check`.

```bash
git add src/notifications
git commit -m "feat: weekly digest emails as a pg-boss digest queue"
```

---

### Task 4: Cutover gating, docs, and the operator checklist

**Files:**
- Modify: `.env.example` (final pass), `docs/DEPLOYMENT.md` (notifications section), `docs/superpowers/plans/README.md` (status)

- [ ] **Step 1: Verify the gate semantics**

Read `isFamilyEnabled` in `src/pipeline/families.ts`. Both queues must be invisible until `CUTOVER_REMINDERS` / `CUTOVER_DIGEST` are set (any truthy value), matching the scrape/tag/review staging behavior. Write a one-line unit test per queue service if `families.ts` does not already test `isFamilyEnabled` for these two families (reuse its existing test file if one exists).

- [ ] **Step 2: Docs**

Append to `docs/DEPLOYMENT.md`:

```markdown
## Notifications (email, staged)

Queues register only when the cutover flags are set: `CUTOVER_REMINDERS`,
`CUTOVER_DIGEST`. Until then nothing sends.

| Variable | Required when enabled | Notes |
| --- | --- | --- |
| RESEND_API_KEY | yes | Resend key. Unset = all email soft-fails (logged, `{sent:false, dev:true}`), jobs still run. |
| RESEND_FROM | recommended | Default `Family Events <onboarding@resend.dev>` (sandbox; must be replaced with a verified domain for production). |
| APP_URL | recommended | Default `https://family-events.up.railway.app`; used for event/logo/unsubscribe links. |

Operator checklist before flipping a flag:
1. Resend hosted template `family-events-event-reminder` exists in the Resend
   account (legacy templates were deployed out-of-repo; recreate if needed).
   The digest needs no template (raw HTML).
2. `RESEND_FROM` is a verified Resend domain.
3. Test run: send a digest to one address via a manual job with
   `{ task: "send", testEmail: "you@example.com" }` (pg-boss dashboard or SQL
   insert into the digest queue).
4. Flip one flag, redeploy, watch the first scheduled run's log summary.
```

- [ ] **Step 3: Gates and commit**

Run: `pnpm check && pnpm test`.

```bash
git add .env.example docs/DEPLOYMENT.md docs/superpowers/plans/README.md
git commit -m "docs: notifications cutover flags and operator checklist"
```

---

## Out of scope (do not touch in this plan)

- Web push, APNs, FCM (legacy `send-push`), Telegram digest, in-app `user_notifications` rows. Email-only per the locked decision; prefs columns for other channels stay unread.
- `process-notification-queue` / the `notify` family (event-change notifications). Legacy scheduling for it is undocumented (recon: no cron container, manual admin label only); it needs its own design (pg-boss delayed jobs vs table+poller) before porting.
- `notify-email` transactional kinds and `send-auth-email` (Supabase Auth hook; the new stack uses Clerk).
- Persistent dedup (a sent-marker table). Legacy has none; this plan preserves parity (no-retry, singleton schedules). A schema change to the shared DB is a deliberate later decision.
- Cron run-log observability (`private.railway_cron_runs` / admin Scheduled Jobs page). Tracked under U32/plan 007 follow-ups.
- Relaxing legacy rate-limit constants (batch 10/300ms). pg-boss makes them unnecessary; removing them is fine ONLY where they are pure loops in ported code, never a behavior change for recipients.

## Escape hatches

- If `plan_events_for_user_range`'s params do not match `PlanRepository.planForRange`'s input (name drift between repos), stop and report the actual repository SQL; do not add a second RPC wrapper.
- If the legacy `buildExplanation` factor keys differ from this plan's example strings, port the source's keys and labels verbatim and note the correction in the commit body.
- If `user_notification_preferences` rows can exist with `digest_telegram = true, digest_email = false`, the email-first filter `digest_email IS TRUE` is correct; do not "fix" it to include Telegram-only users.
- If `JobsService.registerQueue` rejects a second schedule key or the FAMILIES options conflict with `retryLimit: 0`, follow the `JobsService` API as-is (it validates) and report the conflict instead of bypassing it.
