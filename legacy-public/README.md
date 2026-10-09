# Legacy public origin compatibility

This package prepares replacements for exactly four existing public Supabase
functions: `events-api`, `events-feed`, `share-og`, and `sitemap`. It has not been
deployed. It preserves requests arriving at the old Supabase origin after the
app moved to the canonical domain. It does not change the frozen backend,
database, authentication, job owners, DNS, or historical Railway web routing.

Each entrypoint requires `PUBLIC_APP_URL`. The intended production value is
`https://family-events.org`. Missing or invalid configuration returns sanitized
503/no-store without a fallback. Only an HTTPS origin with no credentials,
path, query, or fragment is accepted; HTTP is allowed only for loopback fixtures.
The request Host, Forwarded headers and query never select that origin.

| Old function                                                  | Canonical destination                                                                     |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `events-api` root or UUID suffix                              | `/api/events` or `/api/events/:uuid`                                                      |
| `events-feed`                                                 | `/feeds/events`, retaining `format` and `city`                                            |
| `share-og` root/query or UUID suffix                          | 307 to `/functions/v1/share-og`, retaining the suffix and `eventId`/`event_id` precedence |
| `sitemap` root, `sitemap.xml`, `robots.txt`, or `type=robots` | `/sitemap.xml` or `/robots.txt`                                                           |

GET is anonymous. All four handlers answer valid OPTIONS with an empty 200 and
open CORS for GET/OPTIONS and the legacy client header allowlist. They do not
permit credentialed CORS. Other methods return 405, unsupported suffixes 404.
This deliberately standardizes OPTIONS for feeds/sitemaps and stops accepting
the incidental write methods or extra preview suffixes some old handlers
accepted. No evidenced caller requires those behaviors.

Proxy requests retain only documented query parameters and send no caller
Authorization, API key, cookie, conditional or forwarding headers. Upstream
redirects are not followed. Only public response media types and an explicit
header allowlist are returned; cookies, internal headers and upstream CORS are
discarded. Public 400/404 bodies retain their statuses with no-store. Network
failure, unsafe redirect, unexpected response, a body exceeding **8 MiB**, or
the **10-second** fetch/body deadline returns sanitized 503/no-store. The
complete bounded body is read before returning, so a stalled stream cannot
become a truncated successful feed. Successful bodies preserve bytes, media
type, attachment metadata and cache headers.

Supabase documents that GET `text/html` responses on its default origin are
rewritten to `text/plain`. Preview requests redirect to the canonical HTML alias
so crawlers can request an HTML page.
XML/RSS/ICS/robots are proxied; the documented restriction names HTML, but actual
hosted XML media types still require post-deployment verification.
See [platform limits](https://supabase.com/docs/guides/functions/limits).

## Local verification

From the API checkout:

```sh
node --test legacy-public/test/proxy.test.mjs
```

The tests use owned loopback HTTP fixtures, portable Web APIs and Node built-ins.
They exercise forwarding, query traps, header privacy, status/cache/MIME,
preflight, canonical redirects, configuration failure, timeouts, response caps,
and the actual entrypoints. No provider, database or dependency installation is
required. The app's existing alias tests remain the destination contract.

## Separately approved deployment

1. Obtain explicit approval to authenticate to project
   `ufrjcnozcapskjtoakvf`, publish exactly these four replacement functions, and
   set only `PUBLIC_APP_URL=https://family-events.org`. Existing read-only
   connector access was permission denied; deployment access is not established.
   No CLI was installed or authentication attempted for this preparation.
2. Confirm canonical JSON, RSS, ICS, sitemap, robots and preview responses are
   healthy. Privately retain the current four function versions/source and
   configuration for rollback, without exporting credentials into logs or Git.
3. With an already approved CLI/session, inspect `supabase --help`,
   `supabase functions deploy --help`, and `supabase secrets set --help` before
   issuing writes. Use this package's `legacy-public` workdir and explicit remote
   project ref; never deploy all functions, push the complete project config,
   apply migrations, or use the frozen backend's deployment pipeline.
4. Configure the approved public URL, then publish each named function using the
   custom `.mjs` entrypoints in `supabase/config.toml`. `verify_jwt=false` retains
   the existing anonymous policy for these four functions only. Supabase supports
   `.mjs` custom entrypoints with CLI >=1.215.0; see
   [function configuration](https://supabase.com/docs/guides/functions/function-configuration).

The following is the bounded command shape after approval and help verification,
run from the API checkout. The public URL is not a credential:

```sh
supabase secrets set PUBLIC_APP_URL=https://family-events.org --project-ref ufrjcnozcapskjtoakvf --workdir legacy-public
supabase functions deploy events-api --project-ref ufrjcnozcapskjtoakvf --workdir legacy-public
supabase functions deploy events-feed --project-ref ufrjcnozcapskjtoakvf --workdir legacy-public
supabase functions deploy share-og --project-ref ufrjcnozcapskjtoakvf --workdir legacy-public
supabase functions deploy sitemap --project-ref ufrjcnozcapskjtoakvf --workdir legacy-public
```

The configuration writes and four publications are separate operations, not an
atomic deployment. Verify each named result before continuing. See the
[CLI reference](https://supabase.com/docs/reference/cli/supabase-functions-deploy).

## Acceptance and retention

Verify through `https://ufrjcnozcapskjtoakvf.supabase.co/functions/v1/...`, without
authentication: collection and published/missing UUID JSON, query validation,
GET/OPTIONS CORS, RSS and ICS city queries, XML/robots MIME and canonical URLs,
and preview path/query redirects followed to rendered HTML. Confirm no cookies
or private upstream headers escape. Use only published fixture events and
sanitized response metadata; do not log provider headers, codes or tokens.

Refresh an approved existing feed subscription and verify previews with the
actual intended crawler before claiming external consumer acceptance. A local
redirect test cannot establish a client's willingness to follow it. Retain
proxy functions while subscription/partner evidence is unknown. Decommission,
redirect changes for historical Railway hosts and DNS changes each require
separate approval. An empty repository consumer inventory is not proof of zero
active consumers.

If a compatibility publication fails acceptance, an explicitly approved rollback
can republish only the retained prior versions of these four public functions.
That restores their Supabase data dependency. The observed old feed contains no
events despite available upcoming events, so restoring its old version may
restore that failure. Rollback covers only these four functions. Hosted
Supabase gateway acceptance and old-origin cutover remain pending.
