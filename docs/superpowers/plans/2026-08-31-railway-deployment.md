# Railway Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make both new services deployable to Railway: `railway.toml` for each, CORS so the app can call the API cross-origin, and an environment manifest (docs/DEPLOYMENT.md) per repo so secret entry is a checklist, not archaeology.

**Architecture:** This plan spans two checkouts; it lives in the API repo and names app-repo files as `../family-events-app/...`. Each repo gets a `railway.toml` using the pattern proven in the legacy `family-events-web` repo (build command, start command, healthcheck path). CORS is opt-in via a new `WEB_ORIGIN` env var on the API (absent = no CORS headers, current behavior, so local same-origin and server-function usage are unaffected). No GH deploy workflows here: Railway's git integration is the deploy path until the operator decides otherwise (see Out of scope).

**Tech Stack:** Railway (railpack), NestJS 11 `enableCors`, TanStack Start nitro output, Node 22.

**Spec:** Legacy `family-events-web/railway.toml` (proven buildCommand/startCommand/healthcheckPath shape); api rewrite plan `docs/plans/2026-08-16-002-nestjs-backend-rewrite-plan.md` (U32 deployment). Baseline commit: `4dbaa42` (api). Verified facts this plan builds on: API serves `/healthz` (liveness, DB-free) and `/readyz` (DB ping) from an unprefixed controller; API start is `node dist/src/main.js`; app serves `/healthz` as a TanStack server route; app start is `node .output/server/index.mjs`; app build is `vite build`.

## Global Constraints

- Gates: api `pnpm check`; app `cd ../family-events-app && pnpm check && pnpm test:guards`.
- Secrets are never written to any file in either repo. `.env.example` gains variable NAMES with placeholder values only.
- No production URLs invented in configs; the app's `VITE_API_URL`-style variable (if the app reads one, check its `.env.example`) is documented in DEPLOYMENT.md as an operator entry, not baked into `railway.toml`.
- Railway variables: NODE_VERSION=22 must be pinned in both services.

---

### Task 1: API accepts a web origin for CORS

The app is a full-stack TanStack Start server today; at cutover its client calls the API cross-origin. Without CORS those browser calls fail with opaque network errors. Add the env var and enable CORS only when it is set.

**Files:**
- Modify: `src/config/env.ts` (add `WEB_ORIGIN` to the zod schema)
- Modify: `src/config/env.test.ts` (one case)
- Modify: `src/main.ts` (enableCors when set)
- Modify: `.env.example` (document)

**Interfaces:**
- Produces: `WEB_ORIGIN` (optional, url, no trailing slash enforced by normalization) in the validated env. Behavior: unset = no CORS change; set = `app.enableCors({ origin: <value>, credentials: true })` before `app.listen`.

- [ ] **Step 1: Add the env case**

In `src/config/env.test.ts`, add one test following the file's existing pattern (adapt literal style):

```ts
  it("accepts an optional WEB_ORIGIN and rejects a non-URL", () => {
    const parsed = envSchema.safeParse({ ...minimalValidEnv, WEB_ORIGIN: "https://events.example.com" });
    expect(parsed.success).toBe(true);

    const bad = envSchema.safeParse({ ...minimalValidEnv, WEB_ORIGIN: "not a url" });
    expect(bad.success).toBe(false);
  });
```

Run: `pnpm vitest run src/config/env.test.ts`
Expected: FAIL (schema rejects or ignores `WEB_ORIGIN` depending on strictness; either way the case fails).

In `src/config/env.ts`, add to `envSchema` alongside the other optional string vars (match the file's field style):

```ts
  WEB_ORIGIN: z.string().url().optional(),
```

Run: `pnpm vitest run src/config/env.test.ts`
Expected: PASS.

- [ ] **Step 2: Enable CORS in main.ts**

In `src/main.ts`, where the app is assembled (after `app.useGlobalPipes(...)`, before `app.listen(...)`):

```ts
  // The web app calls this API from the browser at cutover; without CORS those
  // requests die as opaque network errors. Unset = same-origin/server-to-server
  // only (current behavior).
  const webOrigin = configService.get<string>("WEB_ORIGIN", { infer: true });
  if (webOrigin) {
    app.enableCors({ origin: webOrigin, credentials: true });
  }
```

Adapt `configService` to however `main.ts` already obtains PORT from config (it does; reuse that reference rather than constructing a second one).

- [ ] **Step 3: Document in .env.example and commit**

Add to `.env.example` near the other optional vars:

```
# Public origin of the web app; enables CORS for browser calls (unset in local dev)
WEB_ORIGIN=
```

Run: `pnpm check`
Expected: pass.

```bash
git add src/config/env.ts src/config/env.test.ts src/main.ts .env.example
git commit -m "feat: optional WEB_ORIGIN enables CORS for the web app"
```

---

### Task 2: API railway.toml

**Files:**
- Create: `railway.toml`

- [ ] **Step 1: Write it**

`railway.toml` (pattern from legacy `family-events-web/railway.toml`):

```toml
[build]
builder = "RAILPACK"
buildCommand = "corepack enable && pnpm install --frozen-lockfile && pnpm build"

[deploy]
startCommand = "node dist/src/main.js"
healthcheckPath = "/healthz"
healthcheckTimeout = 100
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 3
```

Notes for the executor: `/healthz` is deliberately the healthcheck (not `/readyz`) so a database hiccup does not restart-loop the container; readiness is `/readyz` for any platform that supports a second probe. If the repo later renames the health route, this file must move with it.

- [ ] **Step 2: Sanity-check the build path locally**

Run: `pnpm build && ls dist/src/main.js && node -e "process.env.DATABASE_URL='postgres://x'; process.env.CLERK_SECRET_KEY='sk_test_x'; import('./dist/src/main.js')" 2>&1 | head -5`
Expected: build succeeds and `dist/src/main.js` exists. (The import attempt may fail on missing config values; that is fine, you are verifying the artifact path, not booting it. Kill anything that starts.)

- [ ] **Step 3: Commit**

```bash
git add railway.toml
git commit -m "deploy: railway config with liveness healthcheck"
```

---

### Task 3: App railway.toml (in ../family-events-app)

**Files:**
- Create: `../family-events-app/railway.toml`

- [ ] **Step 1: Write it**

```toml
[build]
builder = "RAILPACK"
buildCommand = "corepack enable && pnpm install --frozen-lockfile && pnpm build"

[deploy]
startCommand = "node .output/server/index.mjs"
healthcheckPath = "/healthz"
healthcheckTimeout = 100
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 3
```

- [ ] **Step 2: Verify the artifact path**

Run: `cd ../family-events-app && pnpm build && ls .output/server/index.mjs`
Expected: exists (the Playwright webServer already uses this path, so it should).

- [ ] **Step 3: Gates and commit**

Run: `cd ../family-events-app && pnpm check && pnpm test:guards`

```bash
cd ../family-events-app
git add railway.toml
git commit -m "deploy: railway config with liveness healthcheck"
```

---

### Task 4: Environment manifests (docs/DEPLOYMENT.md in both repos)

The legacy deployment knowledge lives in people's heads and in the legacy repos' Railway dashboard. Write the manifest per service: every variable, where it comes from, and what breaks without it. NO secret values.

**Files:**
- Create: `docs/DEPLOYMENT.md` (api)
- Create: `../family-events-app/docs/DEPLOYMENT.md` (app)

**Interfaces:**
- Consumes: `src/config/env.ts` (api, the authoritative list) and the app's `.env.example` (read both before writing; the tables below are the required coverage, but the executor MUST reconcile against the actual schemas and correct the tables if they diverge).

- [ ] **Step 1: Read both sources of truth**

Read `src/config/env.ts` and `../family-events-app/.env.example` end to end. The tables in Step 2 are the shape; fix names/optionality against what you read, and note any variable that exists in `.env.example` but not in code (or vice versa) in the commit body.

- [ ] **Step 2: Write the api manifest**

`docs/DEPLOYMENT.md`:

```markdown
# Deployment (family-events-api)

Railway service, railpack build, Node 22 (`NODE_VERSION=22` service variable).
Healthcheck: GET /healthz (liveness, no DB). GET /readyz pings the database.

## Service variables

| Variable | Required | Notes |
| --- | --- | --- |
| DATABASE_URL | yes | Postgres connection string. Cutover: the shared Supabase Postgres (session pooler URL, RLS-exempt role per the rewrite plan). Local dev uses 127.0.0.1:55322. |
| CLERK_SECRET_KEY | yes | Clerk secret key (`sk_...`). Fail-closed: auth reports unauthenticated if unset. |
| WEB_ORIGIN | no | Public origin of the web app (e.g. https://<app>.up.railway.app). Enables CORS with credentials for browser calls. |
| CUTOVER_* | no | Cutover flags from the rewrite plan; all default off. Set only during the migration window. |
| PGBOSS_SCHEMA | no | pg-boss schema name when the default is not wanted. |
| Node runtime | | NODE_VERSION=22 (Railway service variable, not a .env). |

## Deploy flow (operator)

1. Create/link the Railway service to this repo (git integration; main branch).
2. Set the service variables above. Never paste secrets into files or chat.
3. First deploy: verify /healthz returns 200 and /readyz returns 200 (DB reachable).
4. Smoke: GET /v1/events returns events from the shared database.

## After cutover (informational)

pg-boss replaces the legacy Railway cron containers; the legacy side gates its
crons behind private.cron_enabled. Both must not run schedules simultaneously.
```

(The `CUTOVER_*` and `PGBOSS_SCHEMA` rows must be reconciled with env.ts in Step 1; adjust to the real names.)

- [ ] **Step 3: Write the app manifest**

`../family-events-app/docs/DEPLOYMENT.md`, same structure:

```markdown
# Deployment (family-events-app)

Railway service, railpack build, Node 22 (`NODE_VERSION=22` service variable).
Healthcheck: GET /healthz.

## Service variables

| Variable | Required | Notes |
| --- | --- | --- |
| DATABASE_URL | yes | Same shared Postgres as the API (the app's server functions query it directly until cutover). |
| CLERK_PUBLISHABLE_KEY | yes | Clerk publishable key (`pk_...`), used client-side. |
| CLERK_SECRET_KEY | yes | Clerk secret key (`sk_...`), used by server-side auth. |
| WEB_ORIGIN | no | If the app reads one (check .env.example); otherwise omit. |
| (any VITE_/API URL var the app reads) | see .env.example | Point it at the API service's public URL at cutover. |

## Deploy flow (operator)

1. Create/link the Railway service to the family-events-app repo (main branch).
2. Set the variables above plus NODE_VERSION=22.
3. First deploy: verify /healthz returns 200, then load / in a browser:
   events should render (DB reachable), sign-in should open Clerk.
4. Set the API service's WEB_ORIGIN to this app's public URL and redeploy the API.
```

- [ ] **Step 4: Gates and commit**

Run: `pnpm check` (docs only, but cheap).

```bash
git add docs/DEPLOYMENT.md
git commit -m "docs: deployment environment manifest for the api service"
cd ../family-events-app && git add docs/DEPLOYMENT.md && git commit -m "docs: deployment environment manifest for the app service"
```

---

## Out of scope (do not touch in this plan)

- GH Actions deploy workflows (Railway git integration is the deploy path; a token-based workflow needs operator choices about environments and approvals).
- Custom domains, TLS, Railway project topology, or the pg-boss cron enablement itself (the rewrite plan's U32 owns that; the manifest only documents it).
- The app's client-side switch from server functions to the API (cutover, U33).
- Renaming or adding health endpoints.

## Escape hatches

- If `main.ts` obtains config differently than assumed (no `configService` reference), adapt the snippet to the file's actual accessor; do not introduce a second ConfigService.
- If the app's build output path differs from `.output/server/index.mjs`, fix `railway.toml` AND `playwright.config.ts`'s webServer in the same change (or report if that seems wrong).
- If env.ts uses a transform that strips unknown keys silently, the Task 1 test still works (parse succeeds with WEB_ORIGIN present only after the schema addition); if `strictObject`/`strict()` rejects it pre-change, that is the expected Step 1 failure.
