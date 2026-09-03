# Family-events-api: Migration Plans

Plans produced by the 2026-08-31 migration review (port from family-events-backend/family-events-web to family-events-api/family-events-app). This repo's consumer work is small because the rewrite plan (docs/plans/2026-08-16-002) already covers the big units; these are the review-found fixes and the deployment start.

| # | Plan | Scope | Depends on | Status |
| --- | --- | --- | --- | --- |
| 002 | [consumer-correctness-fixes](2026-08-31-consumer-correctness-fixes.md) | Cursor over-emission, PG errors as 500s, rolling plan window, unbounded keyword + opaque validation errors | none (baseline `4dbaa42`) | done (#27) |
| 005 | [railway-deployment](2026-08-31-railway-deployment.md) | `railway.toml` for both services, `WEB_ORIGIN` CORS, per-repo deployment manifests | none for api tasks; app tasks run in `../family-events-app` | done (#28, app #5) |
| 006 | [notifications-email](2026-08-31-notifications-email.md) | Reminders + weekly digest as pg-boss queues (`reminders`/`digest` families), soft-fail Resend MailService, legacy parity (no-retry, America/Chicago, same schedules) | none; sends gated by `CUTOVER_REMINDERS`/`CUTOVER_DIGEST` | done (#29) |

Cross-repo counterparts live in `../family-events-app/docs/superpowers/plans/README.md` (app plans 001, 003, 004).

Execution notes:

- Plans 002 and 005 are complete; app contract plan 004 is also complete.
- 006 covers only the email slice of rewrite-plan U30 (web push, Telegram, event-change notifications explicitly out of scope).
- The admin surface is app-side for now (see app plan 007: polling queue over the legacy admin RPCs); API-side operator-guarded admin endpoints belong to U31 at cutover.
