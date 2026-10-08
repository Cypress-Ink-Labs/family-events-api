# User access and account deletion

Operators use `/admin/access` to search existing access records, enable or disable another user, and delete permitted non-administrator accounts. Disabling accepts an optional reason. Enabling preserves `access_expires_at`, so an expired account stays expired. Self-disable, self-delete and administrator deletion are rejected by the API and the frozen database operations.

Apply `20261008006000_coordinated_account_deletion.sql` before deploying these callers. It requires the retained UUID/lifecycle and transactional-email migrations. The private deletion ledger has no foreign key to the account, so completed outcomes survive storage cleanup. Its service-only policy and the access trigger prevent a deleted or staged UUID from being enabled again.

## Coordinated deletion

`DELETE /v1/admin/users/{uuid}` accepts only an empty body. The API selects the trusted Clerk mapping; clients cannot select a Clerk identifier. An enabled database administrator is required for every database transaction.

1. A transaction locks the UUID and Clerk lifecycle, persists a deletion request and its original profile/access audit snapshot, tombstones the Clerk identity, removes its mapping, disables access, and cancels/scrubs every unsent welcome outbox row, including uncertain or processing rows. If the required audit cannot persist, the transaction rolls back before contacting Clerk.
2. The API calls Clerk's official `DELETE /v1/users/{user_id}`, bounded to 10 seconds with redirects refused. A successful response must identify the selected account and confirm `deleted: true`. A 404 confirms absence. Network errors, missing configuration and other responses leave access revoked and return 503.
3. After persisting provider confirmation, the API calls the existing `admin_delete_user` operation. Its ordinary cascade cleanup and `user.delete` audit remain intact. A storage failure leaves `pending_cleanup`; retry skips the already confirmed provider deletion.
4. A protected attribution foreign key yields `cleanup_deferred` and HTTP 409. Personal rows owned through existing single-column CASCADE foreign keys to `auth.users` or `user_profiles` are removed, while the disabled access row, UUID/profile, RESTRICT and SET NULL historical attribution, and audit evidence remain. Profile contact/family/avatar fields and compatibility auth email/metadata are cleared. A later retry can finish after the attribution restriction is resolved through its owning workflow. No constraint is weakened and no audit is deleted.

Clerk's [user deletion documentation](https://clerk.com/docs/reference/backend/user/delete-user) describes the endpoint. The [official Backend API OpenAPI specification](https://github.com/clerk/openapi-specs/blob/main/bapi/2026-05-12.yml) defines its successful deleted-object response and resource-not-found response. No provider operation is performed by the fixture tests.

## Outcomes and retries

`GET /v1/admin/users/deletions` exposes only metadata for the latest 100 requests, ordered by request time and UUID. It never exposes Clerk identifiers, stored provider credentials, payloads or audit snapshots.

| Status | Meaning |
| --- | --- |
| `pending_provider` | Local access revoked, provider absence unconfirmed. |
| `pending_cleanup` | Provider confirmed absent, storage cleanup unfinished. |
| `cleanup_deferred` | Provider absent and personal rows cleaned, historical UUID protected. |
| `completed` | Provider absent and ordinary storage cleanup completed. |

Claims last 30 seconds. Concurrent requests during an active claim return 409; writes are fenced by the claim's attempt counter. A lost provider acknowledgement remains pending and leased. After the lease expires, retrying the same UUID confirms provider absence and continues cleanup. Completed retries return `{ "ok": true }` without contacting Clerk or duplicating deletion audits. Signed lifecycle replays cannot recreate the tombstoned mapping.

The app refreshes outcomes after every mutation, including a failed deletion. Bulk deletion runs selected UUIDs sequentially and reports partial outcomes. A pending or deferred account is never reported as completed. Unsent mail cancellation cannot recall a message already accepted by its provider.

## Verification and rollout

Owned disposable PostgreSQL tests exercise the HTTP authorization boundary, real audit and ownership constraints, trusted provider selection, failures, concurrency, retries, cleanup and old bearer rejection. HTTP provider fixtures never contact Clerk. Signed-out browser checks conceal the route; a configured Clerk operator browser session and controlled external Clerk sandbox deletion remain rollout acceptance checks.

Before rollback, stop deletion callers, allow active claims to settle, and export the private deletion ledger for reconciliation. The paired down migration removes the new access trigger and ledger only. Retain the lifecycle tombstones, revoked mappings, disabled access and audit evidence; rollback must never restore account access. Outstanding pending/deferred work needs an operator reconciliation owner before dropping its durable status.
