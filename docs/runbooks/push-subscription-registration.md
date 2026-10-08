# Browser push registration

Apply `20261008005000_push_subscription_devices` before enabling the new consumer registration route. The legacy two `UNIQUE NULLS NOT DISTINCT` constraints accidentally restrict each account to one browser and one mobile device, because the other platform's identifier is null. Ordinary unique constraints preserve endpoint/token uniqueness per owner while allowing multiple devices. Existing rows and keys are unchanged.

Registration uses the same trusted endpoint policy and VAPID credential source as the existing sender. Only the validated public VAPID key reaches the app. Permission, local subscription, API owner registration and saved preferences must all succeed before the app reports active push. A subscription endpoint already owned by another account is rejected, including concurrent attempts; the user can remove that browser's local subscription and register a fresh one.

Turning off both reminder and change push removes that account's web registrations; mobile registrations remain intact. Digest push is unsupported by the existing digest sender. Its legacy value remains stored without being presented as an available delivery channel. Unrelated Telegram settings are preserved.

The paired rollback checks compatibility before changing constraints. Multiple browsers have the same null token and multiple mobile devices have the same null endpoint, so they cannot fit the legacy rules. Rollback refuses without deleting registrations when either grouping has duplicates. Review retention and rollback with the operator before proceeding; do not delete subscriptions automatically to make rollback succeed.

Read-only rollback inventory:

```sql
SELECT user_id, count(*) AS devices
FROM public.push_subscriptions
WHERE platform = 'web'
GROUP BY user_id HAVING count(*) > 1;

SELECT user_id, count(*) AS devices
FROM public.push_subscriptions
WHERE platform IN ('ios', 'android')
GROUP BY user_id HAVING count(*) > 1;
```

Local verification uses disposable PostgreSQL, generated fixture keys and browser API fixtures. No provider delivery or production cutover is included. Controlled Clerk browser acceptance and real-recipient delivery remain separate rollout prerequisites.
