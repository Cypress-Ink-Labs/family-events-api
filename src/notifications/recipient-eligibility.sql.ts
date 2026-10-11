export function recipientEligibilitySql(
  userIdColumn: "p.id" | "f.user_id" | "subscription.user_id"
): string {
  return `NOT EXISTS (
    SELECT FROM private.account_deletions deletion
    WHERE deletion.user_id = ${userIdColumn}
  ) AND NOT EXISTS (
    SELECT FROM private.clerk_user_lifecycle lifecycle
    WHERE lifecycle.storage_uuid = ${userIdColumn}
      AND lifecycle.deleted_at IS NOT NULL
  )`
}
