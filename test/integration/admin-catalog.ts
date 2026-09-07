import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { DbService } from "../../src/db/db.service.js"

import { ensureIngestionSchema, truncateIngestion } from "./ingestion-catalog.js"

/** Production review RPCs on the disposable catalog, never a backend migration. */
export async function ensureAdminCatalog(db: DbService): Promise<void> {
  await ensureIngestionSchema(db)
  await db.query("CREATE SCHEMA IF NOT EXISTS private")
  await db.query(`
    DROP TABLE IF EXISTS public.user_access CASCADE;
    CREATE TABLE public.user_access (
      user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
      is_enabled boolean NOT NULL DEFAULT false,
      access_expires_at timestamptz,
      enabled_at timestamptz,
      disabled_at timestamptz,
      disabled_reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE public.events
      ADD COLUMN admin_last_edited_at timestamptz,
      ADD COLUMN admin_last_edited_by uuid REFERENCES auth.users (id) ON DELETE SET NULL;
    ALTER TABLE public.admin_audit_log
      ADD CONSTRAINT admin_audit_log_admin_user_id_fkey
      FOREIGN KEY (admin_user_id) REFERENCES auth.users (id) ON DELETE SET NULL;
  `)
  // Supabase auth.uid() reads JWT claims; this bare Postgres equivalent exercises
  // the actual transaction-local claims written by the API repository.
  await db.query(`
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE sql STABLE AS $$
      SELECT coalesce(
        nullif(current_setting('request.jwt.claim.sub', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
      )::uuid
    $$
  `)
  for (const file of ["admin_is_admin.sql", "admin_review_rpcs.sql"]) {
    await db.query(readFileSync(join(process.cwd(), "test/integration/sql", file), "utf8"))
  }
}

export async function truncateAdminCatalog(db: DbService): Promise<void> {
  await truncateIngestion(db)
  await db.query("TRUNCATE public.user_access, auth.users CASCADE")
}
