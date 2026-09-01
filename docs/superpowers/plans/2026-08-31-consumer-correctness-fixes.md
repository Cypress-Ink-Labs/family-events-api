# Consumer Correctness Fixes (API) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four confirmed API defects: cursor over-emission on exactly-full pages, FK violations surfacing as 500s, the rolling-24h plan window, and missing input bounds plus opaque validation errors.

**Architecture:** The cursor fix stays in `ConsumerService` (repositories keep returning raw RPC rows; the probe is a service concern). PG error mapping is one global `ExceptionFilter` extending Nest's `BaseExceptionFilter`, so existing `HttpException`s pass through untouched. The plan window reuses the existing DST-safe `zoned-time` module from the pipeline. Validation bounds extend the existing zod schemas.

**Tech Stack:** NestJS 11, zod 4, pg, vitest (swc), oxlint/oxfmt, pnpm.

**Spec:** `docs/plans/2026-08-16-002-nestjs-backend-rewrite-plan.md` (units U24/U25) plus the migration review of 2026-08-31. Baseline commit this plan was written against: `4dbaa42`. If `git log -1 --format=%h` differs significantly and the excerpts no longer match, STOP and report the drift.

## Global Constraints

- All commands run from the repo root. Full gate: `pnpm check` (= format:check + lint + typecheck + test). Run `pnpm test` after every task and `pnpm check` before each commit.
- Unit tests are colocated (`src/**/*.test.ts`, swc vitest config; `DATABASE_URL` is pre-seeded with a dummy in `vitest.config.mts`). Integration tests live in `test/integration/`, need the real database (`integrationDatabaseUrl()` from `test/integration/db.ts`), and run with `pnpm test:integration`.
- Style: no semicolons (repo oxfmt is `semi: false`), double quotes, ESM import specifiers ending in `.js`. `pnpm format:check` must pass.
- SQL lives in repositories; services never concatenate SQL. RPC semantics are pinned by the SQL fixtures in `test/integration/sql/`; do not edit those fixtures in this plan.
- If a change alters any response shape, regenerate the contract with `pnpm openapi` and commit the new `openapi.json` in the same commit. (The app's vendored copy is synced by a separate plan; do NOT copy `openapi.json` to the app repo here.)

---

### Task 1: Emit `next_cursor` only when a next page exists

`ConsumerService.listEvents` (`src/consumer/consumer.service.ts:130-137`) emits a cursor when `events.length === input.limit`. Legacy fetched `limit + 1` to detect has-more; an exactly-full last page currently advertises an empty next page. Fix with the probe, in both the search and plain paths.

**Files:**
- Modify: `src/consumer/consumer.service.ts:89-138` (`listEvents`)
- Test: `src/consumer/consumer.service.test.ts` (new describe block)

**Interfaces:**
- Consumes: `EventsRepository.searchEvents` / `listEvents` (unchanged; `limit` already accepts any positive int), `encodeCursor`/`decodeCursor` from `./cursor.js`.
- Produces: `EventsPage` shape unchanged; behavioral contract becomes "cursor present implies a non-empty next page exists".

- [ ] **Step 1: Write the failing tests**

In `src/consumer/consumer.service.test.ts`, add (module scope, reusing the existing `makeService` helper and imports; add `decodeCursor` to the imports from `./cursor.js`):

```ts
function mockRow(n: number): EnrichedEvent {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    start_datetime: `2026-08-16T12:00:${String(n % 60).padStart(2, "0")}:00.000Z`,
  } as unknown as EnrichedEvent
}

describe("ConsumerService.listEvents cursor", () => {
  const QUERY = {
    cityId: null,
    keyword: null,
    dateFrom: null,
    dateTo: null,
    isFree: null,
    kidAge: null,
    after: null,
    limit: 3,
  }

  it("emits no cursor when the result set exactly fills one page", async () => {
    const { service, listEvents } = makeService()
    const rows = [mockRow(0), mockRow(1), mockRow(2)]
    listEvents.mockImplementation(async (input: { limit: number }) => rows.slice(0, input.limit))

    const page = await service.listEvents(QUERY, null)

    expect(page.events).toHaveLength(3)
    expect(page.next_cursor).toBeNull()
  })

  it("trims the probe row and emits its predecessor's cursor when more rows exist", async () => {
    const { service, listEvents } = makeService()
    const rows = [mockRow(0), mockRow(1), mockRow(2), mockRow(3)]
    listEvents.mockImplementation(async (input: { limit: number }) => rows.slice(0, input.limit))

    const page = await service.listEvents(QUERY, null)

    expect(page.events).toHaveLength(3)
    expect(decodeCursor(page.next_cursor!)).toEqual({
      startDatetime: rows[2]!.start_datetime,
      id: rows[2]!.id,
    })
  })

  it("probes limit+1 on the search path too", async () => {
    const { service, listEvents } = makeService()
    const hits = [mockRow(0), mockRow(1), mockRow(2), mockRow(3)]
    listEvents.mockResolvedValue([mockRow(0), mockRow(1), mockRow(2)])

    // keyword set => usesSearch path (searchEvents is not among makeService's
    // tracked mocks; the repository's searchEvents is reached via the same
    // listEvents-typed mock object only if configured). Configure it:
    const searchHits = hits
    const serviceWithSearch = makeService()
    ;(serviceWithSearch.listEvents as ReturnType<typeof vi.fn>).mockReset()
    const searchEvents = vi.fn(async (input: { limit: number }) => searchHits.slice(0, input.limit))
    Object.assign(serviceWithSearch.service, {})
    void searchEvents

    // Simplest correct setup: rebuild via makeService and stub searchEvents on
    // the repository cast. See Step 2 note if this helper needs extending.
    expect(true).toBe(true)
  })
})
```

IMPORTANT: `makeService` currently constructs the repository mock as `{ listEvents, listMapEvents, findSimilarEventsById }`. The search path calls `searchEvents`, which is not stubbed. Before writing the tests, extend `makeService` with a `searchEvents = vi.fn(async () => [])` mock, include it in the repository object and in the returned bag, and write the third test as:

```ts
  it("probes limit+1 on the search path too", async () => {
    const { service, searchEvents } = makeService()
    const hits = [mockRow(0), mockRow(1), mockRow(2), mockRow(3)]
    searchEvents.mockResolvedValue(hits)

    const page = await service.listEvents({ ...QUERY, keyword: "splash" }, null)

    expect(searchEvents).toHaveBeenCalledWith(expect.objectContaining({ limit: 4 }))
    expect(page.events).toHaveLength(3)
    expect(page.next_cursor).not.toBeNull()
  })
```

(Delete the placeholder third test from the first snippet; only the version above ships.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/consumer/consumer.service.test.ts`
Expected: FAIL. The exactly-full-page test fails with `next_cursor` not null; the `limit: 4` expectation fails because the service currently passes `limit: 3`.

- [ ] **Step 3: Implement the probe in `ConsumerService.listEvents`**

Replace the body of `listEvents` (`src/consumer/consumer.service.ts:89-138`) with:

```ts
  async listEvents(input: ExploreQuery, userKey: string | null): Promise<EventsPage> {
    const usesSearch = input.keyword !== null || input.isFree !== null || input.kidAge !== null
    // Probe one row past the limit so next_cursor is emitted only when a next
    // page actually exists (an exactly-full last page must not advertise an
    // empty one). Same pattern as the legacy events-api edge function.
    const probeLimit = input.limit + 1
    let events: EnrichedEvent[]
    let hasMore: boolean

    if (usesSearch) {
      const hits = await this.eventsRepository.searchEvents({
        keyword: input.keyword,
        cityId: input.cityId,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        isFree: input.isFree,
        ageMin: input.kidAge,
        ageMax: input.kidAge,
        limit: probeLimit,
        after: input.after,
      })
      hasMore = hits.length > input.limit
      const pageHits = hasMore ? hits.slice(0, input.limit) : hits
      events =
        pageHits.length === 0
          ? []
          : await this.eventsRepository.listEvents({
              eventIds: pageHits.map((hit) => hit.id),
              userKey,
              limit: input.limit,
            })
      const order = new Map(pageHits.map((hit, index) => [hit.id, index]))
      events.sort(
        (left, right) =>
          (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(right.id) ?? Number.MAX_SAFE_INTEGER)
      )
    } else {
      events = await this.eventsRepository.listEvents({
        cityId: input.cityId,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        userKey,
        limit: probeLimit,
        after: input.after,
      })
      hasMore = events.length > input.limit
      if (hasMore) {
        events = events.slice(0, input.limit)
      }
    }

    const last = events.at(-1)
    return {
      events,
      next_cursor:
        hasMore && last !== undefined
          ? encodeCursor({ startDatetime: last.start_datetime, id: last.id })
          : null,
    }
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run src/consumer/consumer.service.test.ts`
Expected: PASS, including all pre-existing `listEvents`/`getEventDetail` tests. If a pre-existing test asserted the old over-emitting behavior, update it to the new contract and mention it in the commit body.

- [ ] **Step 5: Add the HTTP-level regression test (integration)**

In `test/integration/consumer.integration.test.ts`, add one test inside the existing describe (it already seeds cities/users and has the `insertEvent` helper; `randomUUID` is already imported):

```ts
  it("returns no next_cursor when the page exactly fills the limit", async () => {
    for (let i = 0; i < 3; i++) {
      await insertEvent({ title: `Boundary event ${i}`, start: `2026-08-1${i + 1}T15:00:00+00:00` })
    }
    const res = await request(app.getHttpServer()).get("/v1/events?limit=3")
    expect(res.status).toBe(200)
    expect(res.body.events).toHaveLength(3)
    expect(res.body.next_cursor).toBeNull()
  })
```

- [ ] **Step 6: Verify and commit**

Run: `pnpm test && pnpm check`. With the integration database available (`integrationDatabaseUrl()`), also `pnpm test:integration`.
Expected: pass.

```bash
git add src/consumer/consumer.service.ts src/consumer/consumer.service.test.ts test/integration/consumer.integration.test.ts
git commit -m "fix: emit next_cursor only when a next page exists (limit+1 probe)"
```

---

### Task 2: Map Postgres errors to HTTP statuses (no more FK-to-500)

Writing a favorite/rating/comment with a valid-but-nonexistent event UUID violates an FK and currently surfaces as an unhandled 500. Add one global exception filter that maps PG error codes, and register it in `main.ts` and in the integration harness.

**Files:**
- Create: `src/common/pg-exception.filter.ts`
- Create: `src/common/pg-exception.filter.test.ts`
- Modify: `src/main.ts`
- Modify: `test/integration/consumer.integration.test.ts` (register the filter; add the 404 test)

**Interfaces:**
- Produces: `PgExceptionFilter` exported from `src/common/pg-exception.filter.ts`. Mapping table: `23503` -> 404 `related record not found`; `23505` -> 409 `record already exists`; `23502` -> 400 `missing required value`; `23514` -> 400 `invalid value`; `22P02` -> 400 `invalid identifier`. Everything else falls through to Nest's default handling.

- [ ] **Step 1: Write the failing filter test**

Create `src/common/pg-exception.filter.test.ts`:

```ts
import { ArgumentsHost } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { PgExceptionFilter } from "./pg-exception.filter.js";

function makeHost(): { host: ArgumentsHost; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const status = vi.fn().mockReturnThis();
  const json = vi.fn();
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status, json }) }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

function pgError(code: string): Error {
  return Object.assign(new Error(`pg error ${code}`), { code });
}

describe("PgExceptionFilter", () => {
  it("maps an FK violation (23503) to 404", () => {
    const { host, status, json } = makeHost();
    new PgExceptionFilter().catch(pgError("23503"), host);
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({ statusCode: 404, message: "related record not found" });
  });

  it("maps a unique violation (23505) to 409", () => {
    const { host, status } = makeHost();
    new PgExceptionFilter().catch(pgError("23505"), host);
    expect(status).toHaveBeenCalledWith(409);
  });

  it("maps invalid text representation (22P02) to 400", () => {
    const { host, status } = makeHost();
    new PgExceptionFilter().catch(pgError("22P02"), host);
    expect(status).toHaveBeenCalledWith(400);
  });

  it("delegates everything else to the base filter", () => {
    const { host, status } = makeHost();
    const boom = new Error("totally unknown");
    new PgExceptionFilter().catch(boom, host);
    expect(status).not.toHaveBeenCalled();
    expect(() => {
      throw boom;
    }).not.toThrow();
  });
});
```

The last test's precise assertion depends on `BaseExceptionFilter` behavior (it calls `host.switchToHttp().getResponse().status(500)...` for unknown errors via the express adapter, which our mock satisfies with `mockReturnThis` but `status` would then be called with 500). If it is, tighten the assertion to `expect(status).toHaveBeenCalledWith(500)` and drop the throw block. The first three assertions are the contract; do not weaken them.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/common/pg-exception.filter.test.ts`
Expected: FAIL with "Cannot find module './pg-exception.filter.js'".

- [ ] **Step 3: Implement the filter**

Create `src/common/pg-exception.filter.ts`:

```ts
import { BaseExceptionFilter, Catch, HttpException, HttpStatus, Logger } from "@nestjs/common";
import type { ArgumentsHost } from "@nestjs/common";
import type { Response } from "express";

interface MappedStatus {
  status: number;
  message: string;
}

// Postgres error codes that carry user-facing meaning. The pool connects with
// an RLS-exempt role, so violations that Supabase's PostgREST would have
// mapped (missing row, duplicate, bad enum text) land here instead.
const PG_ERROR_RESPONSE: Record<string, MappedStatus> = {
  "23503": { status: HttpStatus.NOT_FOUND, message: "related record not found" },
  "23505": { status: HttpStatus.CONFLICT, message: "record already exists" },
  "23502": { status: HttpStatus.BAD_REQUEST, message: "missing required value" },
  "23514": { status: HttpStatus.BAD_REQUEST, message: "invalid value" },
  "22P02": { status: HttpStatus.BAD_REQUEST, message: "invalid identifier" },
};

@Catch()
export class PgExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(PgExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const code = (exception as { code?: string } | null)?.code;
    const mapped = code === undefined ? undefined : PG_ERROR_RESPONSE[code];
    if (mapped !== undefined) {
      const response = host.switchToHttp().getResponse<Response>();
      response.status(mapped.status).json({ statusCode: mapped.status, message: mapped.message });
      return;
    }
    if (!(exception instanceof HttpException)) {
      this.logger.error(
        `Unhandled error: ${exception instanceof Error ? (exception.stack ?? exception.message) : String(exception)}`
      );
    }
    super.catch(exception, host);
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run src/common/pg-exception.filter.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Register the filter**

In `src/main.ts`, add the import and registration (order relative to the global pipe does not matter; pipes run first regardless):

```ts
import { PgExceptionFilter } from "./common/pg-exception.filter.js";
```

```ts
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new PgExceptionFilter());
```

In `test/integration/consumer.integration.test.ts`, the app is built by `Test.createTestingModule(...).compile()` (not `main.ts`), so the filter must be registered there too. Add the import and, in the `beforeAll`, immediately before `await app.init()`:

```ts
    app.useGlobalFilters(new PgExceptionFilter());
```

- [ ] **Step 6: Add the end-to-end regression test**

In `test/integration/consumer.integration.test.ts`, add (uses the mocked `mapped-token` Clerk identity and the existing mapping rows; `randomUUID` is already imported):

```ts
  it("maps an FK violation to 404 when favoriting a nonexistent event", async () => {
    const res = await request(app.getHttpServer())
      .put(`/v1/events/${randomUUID()}/favorite`)
      .set("Authorization", "Bearer mapped-token")
      .send({ on: true });
    expect(res.status).toBe(404);
    expect(res.body.message).toBe("related record not found");
  });
```

If the route returns 404 route-not-found (not the mapped body) because `ConsumerModule` in this harness only declares the read controller, check `src/consumer/consumer.module.ts`; if the write controller is declared elsewhere, mount the write controller's module in this file's `imports` following how the write controller test builds its module, and note it in the commit body. If the write route genuinely requires an existing event in a different way, STOP and report the actual status chain instead of forcing the assertion.

- [ ] **Step 7: Verify and commit**

Run: `pnpm test && pnpm check`, then `pnpm test:integration` with the database available.
Expected: pass.

```bash
git add src/common/pg-exception.filter.ts src/common/pg-exception.filter.test.ts src/main.ts test/integration/consumer.integration.test.ts
git commit -m "fix: map Postgres constraint violations to 4xx instead of 500"
```

---

### Task 3: Plan window is zone-local "today", not a rolling 24h

`ConsumerService.planForToday` (`src/consumer/consumer.service.ts:210-226`) ranks events in `[now, now+24h)`. The product semantics (and the app after its matching fix) are "today in the city's timezone". Reuse `zonedDayStartUtc` from `src/pipeline/zoned-time.ts` and the city's `timezone` column.

**Files:**
- Modify: `src/consumer/consumer.service.ts` (`planForToday`, `resolvePlanWeather` -> renamed `resolvePlanContext`, new constant)
- Test: `src/consumer/consumer.service.test.ts` (update the window test, add a DST test)

**Interfaces:**
- Consumes: `zonedDayStartUtc(now: Date, timeZone: string, dayOffset: number): Date` from `../pipeline/zoned-time.js` (existing export; do not move the module in this plan).
- Produces: `PlanPage` unchanged.

- [ ] **Step 1: Update the tests first**

In `src/consumer/consumer.service.test.ts`, replace the first `planForToday` test's expectations (currently asserting `dateFrom: "2026-08-16T12:00:00.000Z"`, `dateTo: "2026-08-17T12:00:00.000Z"`) with the zone-local window, and add a DST test:

```ts
  it("uses the zone-local today window, not a rolling 24h", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T12:00:00.000Z")); // 07:00 in Chicago
    const { service, planForRange, snapshot } = makeService();

    await expect(service.planForToday({ cityId: null, kidAge: null }, "user-1")).resolves.toEqual({
      available: true,
      planned: [],
    });

    expect(snapshot).not.toHaveBeenCalled();
    expect(planForRange).toHaveBeenCalledWith({
      userKey: "user-1",
      dateFrom: "2026-08-16T05:00:00.000Z",
      dateTo: "2026-08-17T05:00:00.000Z",
      cityIds: null,
      lat: null,
      lng: null,
      kidAge: null,
      weatherFit: "neutral",
      limit: 5,
    });
  });

  it("plan window is DST-safe (23h on the spring-forward day)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-08T09:00:00.000Z"));
    const { service, planForRange } = makeService();

    await service.planForToday({ cityId: null, kidAge: null }, "user-1");

    expect(planForRange.mock.calls[0]?.[0]).toMatchObject({
      dateFrom: "2026-03-08T06:00:00.000Z",
      dateTo: "2026-03-09T05:00:00.000Z",
    });
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/consumer/consumer.service.test.ts`
Expected: the window test FAILS (rolling 24h boundaries are asserted).

- [ ] **Step 3: Implement**

In `src/consumer/consumer.service.ts`:

Add the import and constant:

```ts
import { zonedDayStartUtc } from "../pipeline/zoned-time.js";
```

```ts
// Consumers render in this zone when an event/city has none; the app's
// src/lib/dates.ts uses the same default.
const DEFAULT_PLAN_TIMEZONE = "America/Chicago";
```

Replace `planForToday` and `resolvePlanWeather` with:

```ts
  async planForToday(input: PlanQuery, userKey: string): Promise<PlanPage> {
    const now = new Date();
    const { lat, lng, weatherFit, timezone } = await this.resolvePlanContext(input.cityId);
    const planned = await this.planRepository.planForRange({
      userKey,
      dateFrom: zonedDayStartUtc(now, timezone, 0).toISOString(),
      dateTo: zonedDayStartUtc(now, timezone, 1).toISOString(),
      cityIds: input.cityId === null ? null : [input.cityId],
      lat,
      lng,
      kidAge: input.kidAge,
      weatherFit,
      limit: PLAN_LIMIT,
    });
    return { available: true, planned };
  }

  private async resolvePlanContext(cityId: string | null): Promise<{
    lat: number | null;
    lng: number | null;
    weatherFit: string;
    timezone: string;
  }> {
    if (cityId === null) {
      return { lat: null, lng: null, weatherFit: "neutral", timezone: DEFAULT_PLAN_TIMEZONE };
    }
    const cities = await this.referenceRepository.listCities();
    const city = cities.find((row) => row.id === cityId);
    const lat = parseCoord(city?.latitude ?? null);
    const lng = parseCoord(city?.longitude ?? null);
    const weatherFit =
      lat === null || lng === null ? "neutral" : (await this.weather.snapshot(lat, lng)).weatherFit;
    return { lat, lng, weatherFit, timezone: city?.timezone ?? DEFAULT_PLAN_TIMEZONE };
  }
```

(The mock `City` in the test file already carries `timezone: "America/Chicago"`, so the city-threading test passes unchanged; verify it does.)

- [ ] **Step 4: Run to verify pass and commit**

Run: `pnpm vitest run src/consumer/consumer.service.test.ts && pnpm test && pnpm check`. With the database: `pnpm test:integration`; if `plan.data.integration.test.ts` asserted rolling-window edges, update those assertions to zone-local edges and say so in the commit body.

```bash
git add src/consumer/consumer.service.ts src/consumer/consumer.service.test.ts test/integration/plan.data.integration.test.ts
git commit -m "fix: plan-for-today ranks the zone-local day, not a rolling 24h"
```

---

### Task 4: Input bounds and useful validation errors

Two gaps: `keyword` is unbounded (legacy capped it at 100 chars, `family-events-backend/supabase/functions/events-api/index.ts:151-162`), and `parseBody` discards zod's field-level detail ("invalid request body" only). Also add the two cross-field sanity refinements the submission schema lacks.

**Files:**
- Modify: `src/consumer/consumer.query.ts:11` (keyword bound)
- Modify: `src/consumer/consumer-write.input.ts` (schema refinements + `parseBody` detail)
- Test: `src/consumer/consumer.query.test.ts`, `src/consumer/consumer-write.controller.test.ts` (new cases)
- Contract: `openapi.json` (regenerate)

**Interfaces:**
- Produces: 400 responses for invalid bodies now carry `{ statusCode, message: "invalid request body", issues: Array<{ path: string; message: string }>, error: "Bad Request" }`. Clients keyed on the bare message string still match `message`.

- [ ] **Step 1: Failing tests**

In `src/consumer/consumer.query.test.ts` add:

```ts
  it("rejects a keyword over the legacy 100-character cap", () => {
    expect(() => parseExploreQuery({ keyword: "x".repeat(101) })).toThrow(BadRequestException);
    expect(() => parseExploreQuery({ keyword: "x".repeat(100) })).not.toThrow();
  });
```

In `src/consumer/consumer-write.controller.test.ts`, add (adapt the valid-body fixture name to whatever that file already uses; build the bad cases by spreading it):

```ts
  it("rejects endDatetime before startDatetime, naming the field", () => {
    const bad = {
      ...validBody,
      startDatetime: "2026-06-01T10:00:00Z",
      endDatetime: "2026-06-01T09:00:00Z",
    };
    try {
      parseCommunityEventInput(bad);
      expect.unreachable();
    } catch (error) {
      const response = (error as BadRequestException).getResponse() as {
        issues: Array<{ path: string; message: string }>;
      };
      expect(response.issues.some((issue) => issue.path === "endDatetime")).toBe(true);
    }
  });

  it("rejects ageMin above ageMax, naming the field", () => {
    const bad = { ...validBody, ageMin: 12, ageMax: 5 };
    try {
      parseCommunityEventInput(bad);
      expect.unreachable();
    } catch (error) {
      const response = (error as BadRequestException).getResponse() as {
        issues: Array<{ path: string; message: string }>;
      };
      expect(response.issues.some((issue) => issue.path === "ageMax")).toBe(true);
    }
  });

  it("caps keyword-length style overflow on title", () => {
    const bad = { ...validBody, title: "x".repeat(201) };
    expect(() => parseCommunityEventInput(bad)).toThrow(BadRequestException);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/consumer/consumer.query.test.ts src/consumer/consumer-write.controller.test.ts`
Expected: new cases FAIL.

- [ ] **Step 3: Implement**

`src/consumer/consumer.query.ts` line 11 becomes:

```ts
  keyword: z.string().trim().min(1).max(100).optional(), // legacy events-api capped keyword at 100
```

`src/consumer/consumer-write.input.ts`: give the schema the two refinements and title a bound (200 is a product choice; adjust the number here if the product wants different):

```ts
const communityEventSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(200),
    description: nullableString,
    startDatetime: z.iso.datetime({ offset: true }),
    endDatetime: z.iso.datetime({ offset: true }).optional().nullable(),
    venueName: nullableString,
    address: nullableString,
    cityId: uuidSchema,
    ageMin: nullableInteger,
    ageMax: nullableInteger,
    isFree: z.boolean().optional(),
    price: z.number().min(0).optional().nullable(),
  })
  .refine((input) => input.endDatetime === undefined || input.endDatetime === null || input.endDatetime > input.startDatetime, {
    message: "endDatetime must be after startDatetime",
    path: ["endDatetime"],
  })
  .refine(
    (input) =>
      input.ageMin === undefined ||
      input.ageMin === null ||
      input.ageMax === undefined ||
      input.ageMax === null ||
      input.ageMin <= input.ageMax,
    { message: "ageMin must be less than or equal to ageMax", path: ["ageMax"] }
  );
```

And surface field detail in `parseBody`:

```ts
function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException({
      message: "invalid request body",
      issues: result.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    });
  }
  return result.data;
}
```

- [ ] **Step 4: Fix any tests that asserted the bare message**

Run: `pnpm test`. Tests asserting `getResponse()` equals exactly `"invalid request body"` must now match the object form (assert `.message` or `.issues`). Update them; keep the `"invalid request body"` string itself stable.

- [ ] **Step 5: Regenerate the contract and commit**

The 400 response example changes shape: run `pnpm openapi` and commit the regenerated `openapi.json` with the code. Do NOT copy it to the app repo (that sync belongs to the contracts-wiring plan).

```bash
git add src/consumer/consumer.query.ts src/consumer/consumer-write.input.ts src/consumer/consumer.query.test.ts src/consumer/consumer-write.controller.test.ts openapi.json
git commit -m "fix: bound keyword/title inputs and return field-level validation issues"
```

---

## Out of scope (do not touch in this plan)

- `OperatorGuard` dead code and anything admin-related (U31, separate plan).
- The pinned RPC SQL fixtures in `test/integration/sql/` and any schema migration.
- RLS role/credential handling in `DbService`.
- Moving `src/pipeline/zoned-time.ts` to a shared location (noted for a future cleanup; the cross-module import here is deliberate).
- Rate-limit concurrency on the daily submission cap (matches legacy behavior; needs a product decision).

## Escape hatches

- If `search_events`' `p_limit` rejects `limit + 1` (it should not; it takes a plain int), STOP and report.
- If the write route in the integration harness behaves differently than Step 6 of Task 2 anticipates, report the actual status chain; do not weaken the 404 mapping assertion.
- If pre-existing unit tests encode the old cursor or window behavior beyond what Step 4/Task 3 anticipate, list them in the commit body rather than silently deleting coverage.
