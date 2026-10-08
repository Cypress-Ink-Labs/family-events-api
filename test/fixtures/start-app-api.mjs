import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("A disposable DATABASE_URL is required");
const database = new URL(databaseUrl);
const ciBootstrap =
  process.env.CI === "true" && process.env.APP_FIXTURE_ALLOW_CI_BOOTSTRAP_DB === "true";
if (
  !["127.0.0.1", "localhost", "::1", "[::1]"].includes(database.hostname) ||
  (database.port === "55322" && !ciBootstrap)
)
  throw new Error("Fixture API requires a disposable loopback database, never shared Supabase");
const require = createRequire(pathToFileURL(resolve("package.json")));
const { Test } = require("@nestjs/testing");
const { ConfigModule } = require("@nestjs/config");
const { UnauthorizedException, ForbiddenException } = require("@nestjs/common");
const { DbModule } = require("./dist/src/db/db.module.js");
const { DbService } = require("./dist/src/db/db.service.js");
const { DataModule } = require("./dist/src/data/data.module.js");
const { AuthModule } = require("./dist/src/auth/auth.module.js");
const { ClerkAuthGuard } = require("./dist/src/auth/clerk.guard.js");
const { OptionalClerkAuthGuard } = require("./dist/src/auth/optional-clerk.guard.js");
const { IdentityService } = require("./dist/src/auth/identity.service.js");
const { ConsumerModule } = require("./dist/src/consumer/consumer.module.js");
const { AdminModule } = require("./dist/src/admin/admin.module.js");
const { PublicExportsModule } = require("./dist/src/public-exports/public-exports.module.js");
const { HealthModule } = require("./dist/src/health/health.module.js");
const { JobsService } = require("./dist/src/jobs/jobs.service.js");

let now = null;
const RealDate = Date;
class FixtureDate extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [now ?? RealDate.now()]));
  }
  static now() {
    return now ?? RealDate.now();
  }
}
if (process.env.APP_FIXTURE_AUTH === "controlled") globalThis.Date = FixtureDate;
let identity;
function fixtureUser(context) {
  const request = context.switchToHttp().getRequest();
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer fixture:user_"))
    throw new UnauthorizedException("invalid fixture token");
  request.user = { clerkUserId: header.slice("Bearer fixture:".length) };
  return request;
}
const moduleBuilder = Test.createTestingModule({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      load: [() => ({ DATABASE_URL: databaseUrl, NODE_ENV: "test" })],
    }),
    DbModule,
    DataModule,
    AuthModule,
    ConsumerModule,
    AdminModule,
    PublicExportsModule,
    HealthModule,
  ],
})
  .overrideProvider(JobsService)
  .useValue({
    send: async () => {
      throw new Error("Fixture API does not run workers");
    },
  });
if (process.env.APP_FIXTURE_AUTH === "controlled") {
  moduleBuilder.overrideGuard(ClerkAuthGuard).useValue({
    canActivate: (context) => {
      fixtureUser(context);
      return true;
    },
  });
  moduleBuilder.overrideGuard(OptionalClerkAuthGuard).useValue({
    canActivate: async (context) => {
      const request = context.switchToHttp().getRequest();
      if (request.headers.authorization === undefined) return true;
      fixtureUser(context);
      const mapped = await identity.resolve(request.user.clerkUserId);
      if (mapped !== null) {
        if (!(await identity.hasEnabledAccess(mapped.supabaseUuid)))
          throw new ForbiddenException("account access is not enabled");
        request.identity = mapped;
      }
      return true;
    },
  });
}
const module = await moduleBuilder.compile();
const db = module.get(DbService);
if (process.env.APP_FIXTURE_PREPARE_CATALOG === "true") {
  if (ciBootstrap) throw new Error("Catalog reset is forbidden for the CI bootstrap lane");
  const { ensureAdminCatalog } = require("./dist/test/integration/admin-catalog.js");
  const { ensureConsumerSimilaritySchema } = require("./dist/test/integration/catalog.js");
  const existingReports = await db.query(
    "SELECT to_regclass('public.correction_reports') IS NOT NULL AS present",
  );
  if (existingReports[0].present)
    await db.query(
      readFileSync("schema/migrations/20260902006000_correction_reports_down.sql", "utf8"),
    );
  await ensureAdminCatalog(db);
  await ensureConsumerSimilaritySchema(db);
  await db.query(
    `DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END $$`,
  );
  await db.query(
    "DROP VIEW public.event_family_needs; DROP TABLE public.event_family_need_evidence; DROP TYPE public.family_need_claim,public.family_need_value,public.family_need_provenance CASCADE",
  );
  const evidence = readFileSync(
    "schema/migrations/20260902005000_family_needs_evidence.sql",
    "utf8",
  );
  await db.query(
    evidence.slice(
      evidence.indexOf("CREATE TYPE public.family_need_claim"),
      evidence.indexOf("CREATE FUNCTION private.import_family_need_statements"),
    ),
  );
  await db.query(readFileSync("schema/migrations/20260902006000_correction_reports.sql", "utf8"));
  await db.query(`
    ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email text;
    ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS theme_preference text;
    CREATE TABLE IF NOT EXISTS public.clerk_user_mapping(
      clerk_user_id text PRIMARY KEY, supabase_uuid uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
      email text NOT NULL, role text NOT NULL DEFAULT 'member' CHECK(role IN ('member','operator')),
      created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}
identity = module.get(IdentityService);
const app = module.createNestApplication();
const { PgExceptionFilter } = require("./dist/src/common/pg-exception.filter.js");
app.useGlobalFilters(new PgExceptionFilter(app.getHttpAdapter()));
const express = app.getHttpAdapter().getInstance();
express.get("/__fixture/database", (_request, response) =>
  response.json({ host: database.hostname, port: database.port, database: database.pathname }),
);
await app.listen(Number(process.env.PORT ?? 0), "127.0.0.1");
const port = app.getHttpServer().address().port;
process.send?.({ type: "ready", port });
console.log(`Disposable fixture API ready on port ${port}`);
process.on("message", (message) => {
  if (process.env.APP_FIXTURE_AUTH === "controlled" && message?.type === "clock") {
    now = message.value === null ? null : RealDate.parse(message.value);
    if (now !== null && !Number.isFinite(now)) throw new Error("Invalid fixture clock");
    process.send?.({ type: "clock", id: message.id });
  }
});
async function close() {
  await app.close();
  process.exit(0);
}
process.on("SIGTERM", close);
process.on("SIGINT", close);
