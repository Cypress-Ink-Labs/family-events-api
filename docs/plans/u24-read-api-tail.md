# U24 Consumer Read API Tail Implementation Plan

**Goal:** Close the remaining U24 contract gaps between `family-events-app/src/fn/consumer.ts`
and the NestJS OpenAPI surface without re-porting completed writes or adding unused legacy
surfaces.

**Architecture:** Keep the shipped split: controllers validate and authorize HTTP input,
`ConsumerService` composes page responses, and existing owner-scoped repositories perform
parameterized SQL. Add the latest legacy `find_similar_events_by_id` RPC as an integration
fixture and call it through `EventsRepository`. Public map/detail reads retain optional Clerk
personalization; favorites/calendar reads require `ClerkAuthGuard` plus `MappedIdentityGuard`
and derive the storage UUID exclusively from `request.identity`.

**Specs (authority order):**

1. `docs/plans/2026-08-16-002-nestjs-backend-rewrite-plan.md` section U24
2. `~/Projects/personal/web/2026-08-23-003-migration-next-steps.md` step 4
3. `~/Projects/personal/web/family-events-app/src/fn/consumer.ts` and its imported
   `src/server/*.ts` modules (live app contract)
4. Latest legacy migration definition for `public.find_similar_events_by_id`

## Global constraints

- Scope is read-only API parity. Do not change already-landed consumer writes.
- Treat HTTP path/query values as untrusted: strict zod parsing, UUID/date/limit validation,
  and no unknown query keys.
- All SQL remains parameterized. User-owned reads take only the mapped storage UUID supplied by
  the guards; no user identifier is accepted from a path or query.
- Preserve app limits: explore defaults to 24, map caps at 200, detail similarity uses 4, and
  plan-for-today remains 5. Favorites/calendar retain their existing app behavior (unpaged,
  owner-scoped lists).
- Preserve the shipped raw event endpoint. Add a separate composite detail endpoint so existing
  clients do not silently receive a different response shape.
- Notification preferences, notification inbox, and invite reads are excluded unless a live app
  server function or imported server module consumes them. None does at this revision.
- Commit convention: `U24: <description>`. Do not push, merge, deploy, or touch another worktree.
- Gates: focused RED/GREEN tests per slice, then `pnpm check`, `pnpm test:integration`, OpenAPI
  regeneration, and a clean OpenAPI drift check.

## Exact contract gap matrix

`consumer.ts` exports 13 server functions (7 reads and 6 writes), not the 14 claimed by the
newer sequencing note. `isDbConfigured` is a local helper, not a server function.

| App server function | App data calls / contract | API state before this tail | Decision |
| --- | --- | --- | --- |
| `fetchExplore` | cities + enriched/search events; `(start_datetime,id)` cursor; 24 | `GET /v1/cities` + `GET /v1/events` complete | Keep |
| `fetchEventDetail` | enriched event + 4 similar titles + approved comments + own rating | Only raw `GET /v1/events/:id` | Add `GET /v1/events/:id/detail` composite |
| `fetchMapEvents` | published enriched events, city optional, 200; only rows with coords; numeric coords | Missing | Add `GET /v1/events/map` |
| `fetchPlanForToday` | mapped user, 24-hour plan, 5 | `GET /v1/plan` complete | Keep |
| `fetchFavoritesPage` | mapped user's favorites hydrated as enriched events | Repository exists; endpoint missing | Add `GET /v1/me/favorites` |
| `fetchCalendarPage` | mapped user's joined calendar entries | Repository exists; endpoint missing | Add `GET /v1/me/calendar` |
| `fetchSubmitPage` | active cities + session state | `GET /v1/cities` plus client auth state suffice | Keep |
| `setFavorite` | owner-scoped toggle | Complete | Do not touch |
| `setCalendar` | owner-scoped toggle | Complete | Do not touch |
| `rateEvent` | owner-scoped upsert | Complete | Do not touch |
| `postComment` | owner-scoped insert | Complete | Do not touch |
| `removeComment` | owner-scoped delete | Complete | Do not touch |
| `submitEvent` | mapped-user submission + rate limit | Complete | Do not touch |
| Notification preferences/inbox reads | No import, server module, function, or route consumer in `family-events-app` | Missing | Exclude; belongs to a future app/U25-U30 slice |
| Invite reads | No import, server module, function, or route consumer in `family-events-app` | Missing | Exclude; do not invent a contract |
| `public_events` preview | Not consumed by the live app contract | Missing | Exclude from this tail |

## Task 1: Similar-event data seam

**Acceptance criteria:**

- The latest security-definer `find_similar_events_by_id` definition is represented in the
  disposable integration database after the base vector-similarity fixture.
- `EventsRepository` returns only the app-consumed `event_id` and `title` fields and binds event
  id, limit, and optional city id positionally.
- Integration coverage proves unpublished source/neighbor events do not leak.

**Verification:** focused repository unit and real-Postgres integration tests, then full gates.

## Task 2: Detail composite and map reads

**Acceptance criteria:**

- Detail returns the enriched event, up to four similar event titles, approved comments, the
  mapped caller's rating (or null), and signed-in state without accepting a user id.
- Map returns at most 200 published events, optionally city-filtered, drops null-coordinate rows,
  and serializes coordinates as finite numbers.
- Invalid UUID/query inputs return 400; invalid bearer tokens return 401; missing detail events
  preserve the app composite's nullable-event behavior.

**Verification:** service/query unit tests and HTTP integration tests.

## Task 3: Owner-scoped favorites and calendar pages

**Acceptance criteria:**

- Both endpoints require a valid, provisioned Clerk mapping (401 unauthenticated, 403 unmapped).
- Favorite hydration uses only the caller's favorite ids and preserves enriched personalization.
- Calendar results contain only the caller's joined rows; another user's data never appears.

**Verification:** service unit tests plus two-user HTTP integration tests.

## Task 4: Contract and final review

**Acceptance criteria:**

- DTOs describe every new response exactly and `openapi.json` contains the four new operations.
- `pnpm check`, `pnpm test:integration`, and OpenAPI regeneration/drift verification pass.
- Final diff review covers correctness, simplicity, architecture, security, and bounded queries.

**Open questions:** None. The live app contract resolves notification/invite/public-preview scope.
