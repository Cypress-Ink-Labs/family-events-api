import { readFileSync } from "node:fs"
import type { DbService } from "../../src/db/db.service.js"

export async function ensureMaintenanceCatalog(db: DbService) {
  await db.query(`DROP TABLE IF EXISTS public.invite_request_attempts,public.invite_redemption_attempts,public.recommendation_signals CASCADE;
      CREATE TABLE public.invite_request_attempts(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,attempted_at timestamptz NOT NULL);
      CREATE TABLE public.invite_redemption_attempts(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,attempted_at timestamptz NOT NULL);
      CREATE TABLE public.recommendation_signals(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,created_at timestamptz NOT NULL);
      DROP MATERIALIZED VIEW IF EXISTS private.timezone_names_cache CASCADE;
      CREATE MATERIALIZED VIEW private.timezone_names_cache AS SELECT name FROM pg_timezone_names ORDER BY name;
      CREATE UNIQUE INDEX timezone_names_cache_name_uidx ON private.timezone_names_cache(name)`)
  await db.query(readFileSync("test/integration/sql/daily_maintenance.sql", "utf8"))
}
