import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { DbService } from "../../src/db/db.service.js"

/**
 * Installs the consumer catalog the U23 repositories read: the tables the
 * events_enriched / search_events RPCs touch (column names and types match
 * family-events-backend's schema baseline) plus the RPCs themselves,
 * extracted VERBATIM from the backend migrations into test/integration/sql/:
 *
 * - events_enriched.sql  <- 20260601019000_restore_events_enriched_cursor_signature.sql
 *   (grant/revoke statements trimmed: the bare test database has no
 *   anon/authenticated/service_role roles)
 * - search_events.sql    <- 20260601028000_search_events_radius_filter.sql
 *
 * Deviation: events.search_vector is a generated column here, while the real
 * schema maintains it out of band; the FTS semantics under test are the same.
 */
// Vitest always runs from the package root, so resolve from cwd (import.meta
// is unavailable under the CJS-mode typecheck).
const SQL_DIR = join(process.cwd(), "test", "integration", "sql")

export async function ensureCatalogSchema(db: DbService): Promise<void> {
  await db.query("CREATE SCHEMA IF NOT EXISTS extensions")
  await db.query("CREATE EXTENSION IF NOT EXISTS cube WITH SCHEMA extensions")
  await db.query("CREATE EXTENSION IF NOT EXISTS earthdistance WITH SCHEMA extensions")
  await db.query(`DO $$ BEGIN
    CREATE TYPE public.event_status AS ENUM ('draft', 'published', 'rejected', 'archived');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`)
  await db.query(`
    CREATE TABLE IF NOT EXISTS public.cities (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      state text,
      slug text NOT NULL UNIQUE,
      country text NOT NULL DEFAULT 'US',
      timezone text NOT NULL,
      latitude numeric,
      longitude numeric,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS public.events (
      id uuid PRIMARY KEY,
      title text NOT NULL,
      description text,
      start_datetime timestamptz NOT NULL,
      end_datetime timestamptz,
      timezone text,
      venue_name text,
      address text,
      city_id uuid REFERENCES public.cities (id),
      latitude numeric,
      longitude numeric,
      age_min integer,
      age_max integer,
      price numeric,
      is_free boolean NOT NULL DEFAULT false,
      source_url text,
      source_name text,
      source_id uuid,
      images jsonb NOT NULL DEFAULT '[]'::jsonb,
      status public.event_status NOT NULL DEFAULT 'draft',
      ai_confidence numeric,
      ai_tag_provider text,
      recurrence_info jsonb,
      is_featured boolean NOT NULL DEFAULT false,
      is_outdoor boolean,
      parent_tips jsonb,
      parent_tips_generated_at timestamptz,
      view_count integer NOT NULL DEFAULT 0,
      search_vector tsvector GENERATED ALWAYS AS (
        to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, ''))
      ) STORED,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS public.tags (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      slug text NOT NULL UNIQUE,
      color text NOT NULL DEFAULT '#888888'
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS public.event_tags (
      event_id uuid NOT NULL REFERENCES public.events (id) ON DELETE CASCADE,
      tag_id uuid NOT NULL REFERENCES public.tags (id) ON DELETE CASCADE,
      PRIMARY KEY (event_id, tag_id)
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS public.ratings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL,
      event_id uuid NOT NULL REFERENCES public.events (id) ON DELETE CASCADE,
      score integer NOT NULL CHECK (score BETWEEN 1 AND 5),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, event_id)
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS public.favorites (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL,
      event_id uuid NOT NULL REFERENCES public.events (id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, event_id)
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS public.user_calendar_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL,
      event_id uuid NOT NULL REFERENCES public.events (id) ON DELETE CASCADE,
      notes text,
      added_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, event_id)
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS public.event_image_attributions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id uuid NOT NULL REFERENCES public.events (id) ON DELETE CASCADE,
      provider text NOT NULL,
      image_url text NOT NULL,
      matched_tag text,
      unsplash_photo_id text,
      unsplash_photographer_name text,
      unsplash_photographer_username text,
      unsplash_photographer_profile_url text,
      unsplash_photo_url text,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  for (const file of ["events_enriched.sql", "search_events.sql"]) {
    await db.query(readFileSync(join(SQL_DIR, file), "utf8"))
  }
}

export async function truncateCatalog(db: DbService): Promise<void> {
  await db.query(`TRUNCATE
    public.event_image_attributions, public.user_calendar_events, public.favorites,
    public.ratings, public.event_tags, public.tags, public.events, public.cities
    CASCADE`)
}
