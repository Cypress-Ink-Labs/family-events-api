# U31-C2 invitation administration

**Prepared:** 2026-09-08  
**Repository:** `family-events-api`  
**Base commit:** `bb5b407`  
**Working branch:** `feat/u31-c2-invitations`

## Goal

Move invitation administration behind the Nest API while preserving the legacy
PostgreSQL behavior that the current web app uses.

The API must let an operator:

1. inspect the invite gate;
2. list invite-code metadata;
3. create an invite code and receive its plaintext once;
4. revoke an unused or active code;
5. list invite requests by review status;
6. approve one pending request and receive its generated plaintext code once;
7. reject one pending request with optional notes.

Keep `family-events-app` database-backed during U31. Do not deploy either new
service or change a `CUTOVER_*` flag in this unit.

## Delivery boundaries

Implement C2 as two PRs so reviewers can verify plaintext-code handling
separately from request-review concurrency.

### C2a: invite codes and gate status

- gate-status read;
- code metadata list;
- code creation;
- code revocation;
- shared invitation DTOs, input parsing, repository helpers, and test catalog.

### C2b: invite requests

- request list and status filter;
- request approval;
- request rejection;
- one-time approval code response;
- request locking, notification, rollback, and concurrency tests.

C2b branches from merged C2a. Each PR regenerates `openapi.json` and passes the
full API and disposable-PostgreSQL suites.

## Confirmed legacy behavior

### Tables

`family-events-backend/supabase/migrations/20260601000000_schema_baseline.sql`
defines:

- `public.invite_codes`
  - stores `code_hash`, never plaintext;
  - tracks `max_uses`, `used_count`, `expires_at`, `revoked_at`, `notes`,
    `created_by`, and `created_at`;
  - requires a 64-character hash, `max_uses > 0`, and `used_count >= 0`;
- `public.invite_requests`
  - stores `email`, optional `message`, status, linked code, review metadata,
    and optional admin notes;
  - limits email to 320 characters, message to 500, and admin notes to 1,000;
  - uses `pending`, `approved`, and `rejected` statuses.

### RPCs

Use the latest definitions from the baseline unless a later migration replaces
one during implementation inventory.

| Capability | RPC | Result |
| --- | --- | --- |
| Gate status | `public.invites_required()` | boolean |
| Create code | `public.admin_create_invite_code(integer, timestamptz, text)` | one row containing plaintext once |
| Revoke code | `public.admin_revoke_invite_code(uuid)` | boolean |
| Approve request | `public.admin_approve_invite_request(uuid)` | request ID, plaintext code, code ID, email, timestamp |
| Reject request | `public.admin_reject_invite_request(uuid, text)` | boolean |

`admin_approve_invite_request` locks a pending request, creates a single-use
code, links it to the request, marks the request approved, and attempts email
dispatch. A dispatch failure does not fail approval.

`admin_reject_invite_request` locks a pending request, stores trimmed notes,
marks it rejected, and attempts email dispatch. It returns `false` when the
request is missing or already reviewed.

`admin_revoke_invite_code` sets `revoked_at` once. It returns `false` for a
missing or already revoked code.

The latest invite-gate migrations are append-only:

- `20260601012000_disable_invite_gate.sql`;
- `20260601013000_reset_invite_gate_guc.sql`;
- `20260601014000_fix_invite_gate_default.sql`;
- `20260601015000_fix_invite_gate_single_source.sql`.

Read the complete chain before copying `invites_required()` into the
integration catalog. Do not infer its current value from the baseline.

## Consumer contract

The legacy web consumers are:

- `apps/web/src/features/auth/hooks/use-invites.ts`;
- `apps/web/src/features/admin/api/invite-requests.ts`;
- `apps/web/src/features/admin/hooks/use-admin-invite-requests.ts`;
- `apps/web/src/features/admin/pages/admin-invites.tsx`.

The UI relies on these rules:

- code lists contain metadata only;
- create and approve responses reveal plaintext once;
- the UI cannot recover plaintext after dismissing the reveal;
- the request tab defaults to pending requests and can show reviewed history;
- create supports 7-day, 30-day, and no-expiry values;
- reject notes are optional;
- the UI copies and sends codes manually even though approval also attempts
  server-side email dispatch.

## HTTP contract

All routes use:

```text
ClerkAuthGuard
  -> MappedIdentityGuard
  -> OperatorGuard
  -> request.identity.supabaseUuid
  -> transaction-local request.jwt.claims
  -> private.is_admin()
  -> legacy RPC or protected table read
```

The client never supplies the acting database UUID.

### C2a routes

#### `GET /v1/admin/invites/required`

Response:

```json
{ "required": false }
```

The repository must establish actor claims and require database admin access
before calling the gate RPC. This keeps database provisioning behavior
consistent with every other admin route.

#### `GET /v1/admin/invite-codes`

Return rows ordered by `created_at DESC, id`:

```json
[
  {
    "id": "uuid",
    "max_uses": 1,
    "used_count": 0,
    "expires_at": null,
    "revoked_at": null,
    "notes": null,
    "created_by": "uuid",
    "created_at": "raw PostgreSQL timestamp"
  }
]
```

Do not select or return `code_hash`.

#### `POST /v1/admin/invite-codes`

Request:

```json
{
  "max_uses": 1,
  "expires_at": "2026-10-08T00:00:00Z",
  "notes": "Family referral"
}
```

Rules:

- `max_uses` is required, integer, and bounded from 1 to 10,000;
- `expires_at` is optional or null and must include a timezone;
- reject an expiry that is not in the future at service time;
- `notes` is optional or null, trimmed, blank-to-null, maximum 1,000
  characters;
- reject unknown properties.

Response:

```json
{
  "id": "uuid",
  "code": "24-character plaintext",
  "max_uses": 1,
  "expires_at": null,
  "notes": null,
  "created_at": "raw PostgreSQL timestamp"
}
```

The controller returns `code` only from this RPC result. The repository and
service must not log it, include it in an exception, write it to audit
metadata, or retain it in another table.

#### `DELETE /v1/admin/invite-codes/:id`

Accept no request body. Return `{ "ok": true }` when the RPC returns `true`.
Map `false` to 404 so missing and already revoked codes share one concealed
response.

### C2b routes

#### `GET /v1/admin/invite-requests`

Query:

- `status=pending|approved|rejected|all`;
- default: `pending`;
- reject unknown query properties.

Return rows ordered by `created_at DESC, id` with:

- `id`;
- `email`;
- `message`;
- `status`;
- `invite_code_id`;
- `admin_notes`;
- `created_at`;
- `reviewed_at`;
- `reviewed_by`.

Preserve raw timestamp text. This queue is small and the current consumer loads
the full reviewed history, so C2 does not add pagination. Add pagination later
only with an app consumer change.

#### `POST /v1/admin/invite-requests/:id/approve`

Accept no body. Return:

```json
{
  "request_id": "uuid",
  "code": "24-character plaintext",
  "invite_code_id": "uuid",
  "email": "requester@example.com",
  "created_at": "raw PostgreSQL timestamp"
}
```

Map the RPC's `P0002 request not found or already reviewed` failure to 404.
Apply the same plaintext restrictions as code creation.

#### `POST /v1/admin/invite-requests/:id/reject`

Request:

```json
{ "notes": "Outside current service area" }
```

`notes` is optional or null, trimmed, blank-to-null, and limited to 1,000
characters. Return `{ "ok": true }` when the RPC returns `true`; map `false` to
404.

## Audit decision

The inventoried invite RPCs do not write `public.admin_audit_log`. Add
transactional API-side audit records for successful mutations:

| Action | Target | Metadata |
| --- | --- | --- |
| `invite_code.create` | new code ID | max uses, expiry, notes; no plaintext or hash |
| `invite_code.revoke` | code ID | empty object |
| `invite_request.approve` | request ID | generated code ID and email; no plaintext or hash |
| `invite_request.reject` | request ID | normalized notes |

Write each audit row after the RPC in the same `DbService.withTransaction`
callback. An audit failure must roll back the code/request mutation. Before
implementation, search migrations newer than the baseline for the same audit
actions. If a newer RPC already writes one, keep the RPC as the single writer
and do not duplicate it.

## Implementation shape

Add a focused invitation slice under `src/admin`:

```text
admin-invite.controller.ts
admin-invite.dto.ts
admin-invite.input.ts
admin-invite.repository.ts
admin-invite.service.ts
```

Register the controller and providers in `AdminModule`.

### Input layer

- use strict Zod objects;
- convert wire `snake_case` to internal `camelCase`;
- lowercase UUIDs;
- preserve omitted versus explicit null notes/expiry;
- validate timestamps without converting them to `Date` for database transport;
- compare expiry using a temporary `Date` only for future-time validation.

### Repository layer

- use `withAdminActor` for every operation;
- call `requireDatabaseAdmin` before direct table reads and
  `invites_required()`;
- parameterize every value;
- select fixed column lists;
- cast invite-code bigint-like counters to bounded integers only at the DTO
  boundary;
- use one transaction for RPC mutation plus audit;
- return plaintext only as the immediate create/approve method result.

### Service layer

Map:

- database admin denial to stable 403;
- missing/already-finalized request to 404;
- missing/already-revoked code to 404;
- invalid or nonfuture expiry to parser-shaped 400;
- unrelated PostgreSQL and transport failures unchanged.

### Controller layer

- project fixed response properties instead of spreading database rows;
- declare operation IDs, Clerk security, and 400/401/403/404 responses;
- describe one-time plaintext behavior in OpenAPI;
- do not place plaintext codes in examples committed to `openapi.json`.

## Integration catalog

Extend `test/integration/admin-catalog.ts` with production-compatible:

- `public.invite_request_status`;
- `public.invite_codes`;
- `public.invite_requests`;
- their production foreign keys and checks;
- `private.hash_invite_code`;
- latest `public.invites_required`;
- the five admin invite RPCs and wrappers.

Place copied functions in `test/integration/sql/admin_invite_rpcs.sql` with
source migration comments.

Stub `private.dispatch_email_notification(jsonb)` in the disposable catalog.
The stub must support a test-controlled failure. The approve/reject RPCs catch
that failure, matching production's nonblocking notification behavior. Do not
install or call `pg_net`.

## Tests

### Parser and service

Cover:

- unknown properties;
- omitted, null, blank, and overlong notes;
- UUID and status validation;
- max-use bounds;
- raw timestamp acceptance and invalid calendar values;
- past and equal-time expiry rejection;
- stable 403, typed 400, and concealed 404 translation;
- actor identity accepted only from `request.identity`.

### HTTP with real guards

For every route:

- missing/invalid Clerk token: 401;
- unmapped Clerk user: 403;
- mapped member: 404;
- mapped operator without database access: 403;
- provisioned operator: success;
- invalid input never reaches the repository.

Also verify mutation responses expose only documented fields and that list
responses never contain `code`, `code_hash`, or hidden table columns.

### Disposable PostgreSQL

C2a:

- transaction-local actor isolation;
- disabled and expired database access;
- code hash is 64 characters and differs from plaintext;
- plaintext does not appear in persisted rows or audit JSON;
- exact max-use, expiry, and timestamp behavior;
- revoke is one-way;
- concurrent revoke calls yield one success and one concealed miss;
- mutation rolls back when audit insertion fails.

C2b:

- pending/all/status filtering and deterministic ordering;
- approval links exactly one new code;
- two concurrent approvals yield one success and one 404;
- rejection trims notes and records reviewer metadata;
- approval/rejection of reviewed or missing requests returns 404;
- dispatch failure does not undo a successful review;
- audit failure rolls back request status and generated code;
- deleting a linked code follows production FK behavior;
- plaintext never appears in tables, logs captured by the test, or audit JSON.

### OpenAPI

Verify:

- operation IDs and Clerk security;
- closed request bodies;
- status enums and bounds;
- nullable raw timestamps;
- one-time plaintext fields only on create/approve responses;
- typed 400/401/403/404 responses;
- generated `openapi.json` equality;
- the contract matcher rejects unsupported schema keywords.

## Execution order

### C2a

1. Recheck the latest gate and invite RPC definitions.
2. Add integration catalog tables, helpers, and C2a RPCs.
3. Add C2a input, DTO, repository, service, and controller.
4. Add parser/service/repository tests.
5. Add real-guard HTTP tests.
6. Add PostgreSQL secrecy, audit, rollback, and concurrency tests.
7. Extend OpenAPI contract tests and regenerate `openapi.json`.
8. Run full verification, commit, push, open PR, and merge after checks.

### C2b

1. Add request DTOs, filters, and endpoints to the invitation slice.
2. Add approve/reject RPCs to the disposable catalog.
3. Add concurrency, notification-failure, rollback, and secrecy tests.
4. Extend HTTP and OpenAPI coverage.
5. Run full verification, commit, push, open PR, and merge after checks.

## Verification commands

```bash
pnpm check
pnpm openapi

docker run --rm -d \
  --name family-events-api-integration \
  -e POSTGRES_PASSWORD=postgres \
  -p 55431:5432 \
  pgvector/pgvector:pg17

DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55431/postgres \
  pnpm test:integration

docker rm -f family-events-api-integration
```

Never use shared Supabase port `55322` for destructive integration tests.

## Done criteria

U31-C2 is complete when:

- all seven routes are merged;
- code metadata reads cannot expose a hash or plaintext;
- create and approve reveal plaintext once;
- request transitions retain legacy locking and email behavior;
- mutation audits contain no plaintext or hash;
- full API and disposable-PostgreSQL suites pass;
- `openapi.json` matches generated output;
- the app, backend, deployment, secrets, and cutover flags remain unchanged.

## Stop conditions

Stop and ask before implementation when:

- a later migration changes an inventoried RPC signature or adds overlapping
  audit writes;
- the latest invite-gate migration chain cannot produce one deterministic
  `invites_required()` definition;
- preserving notification behavior requires a network call in integration
  tests;
- a mutation would need plaintext persisted outside its immediate response;
- a production schema correction or migration becomes necessary;
- tests would need shared Supabase port `55322`;
- deployment requires a secret or `CUTOVER_*` change.
