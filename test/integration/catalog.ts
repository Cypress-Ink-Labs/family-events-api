import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { DbService } from "../../src/db/db.service.js"

/**
 * Installs the consumer catalog the U23 repositories read and write: the
 * tables the events_enriched / search_events RPCs touch plus the write-side
 * tables (favorites, calendar, ratings, comments, user_profiles,
 * user_preferred_cities). Column names and types match
 * family-events-backend's schema baseline. RPCs are extracted VERBATIM from
 * the backend migrations into test/integration/sql/:
 *
 * - events_enriched.sql  <- 20260601019000_restore_events_enriched_cursor_signature.sql
 *   (grant/revoke statements trimmed: the bare test database has no
 *   anon/authenticated/service_role roles)
 * - search_events.sql    <- 20260601028000_search_events_radius_filter.sql
 * - plan_events_for_user_range.sql
 *     <- 20260724020000_plan_events_for_user_range_hydrated.sql
 *   (grant/revoke statements trimmed; uses cube/earthdistance already
 *   installed above, no pgvector)
 *
 * Deviation: events.search_vector is a generated column here, while the real
 * schema maintains it out of band; the FTS semantics under test are the same.
 * events.submitted_by / llm_review_status come from later migrations
 * (20260601033000 / 20260601004000) that community submit writes.
 */
// Vitest always runs from the package root, so resolve from cwd (import.meta
// is unavailable under the CJS-mode typecheck).
const SQL_DIR = join(process.cwd(), "test", "integration", "sql")

export async function ensureCatalogSchema(db: DbService): Promise<void> {
  await db.query("CREATE SCHEMA IF NOT EXISTS extensions")
  await db.query("CREATE EXTENSION IF NOT EXISTS cube WITH SCHEMA extensions")
  await db.query("CREATE EXTENSION IF NOT EXISTS earthdistance WITH SCHEMA extensions")
  // Drop-first (not IF NOT EXISTS): a stale local fixture must never survive
  // a definition change in this file. Safe because connections come from
  // createIntegrationDb(), which refuses non-disposable databases.
  await db.query(`
    DROP TABLE IF EXISTS
      public.comments, public.user_preferred_cities, public.user_profiles,
      public.event_image_attributions, public.user_calendar_events, public.favorites,
      public.ratings, public.event_tags, public.tags, public.events, public.cities
    CASCADE
  `)
  await db.query("DROP TYPE IF EXISTS public.llm_event_review_status CASCADE")
  await db.query("DROP TYPE IF EXISTS public.event_status CASCADE")
  await db.query(
    "CREATE TYPE public.event_status AS ENUM ('draft', 'published', 'rejected', 'archived')"
  )
  await db.query(`
    CREATE TYPE public.llm_event_review_status AS ENUM (
      'not_required', 'pending', 'succeeded', 'failed', 'skipped'
    )
  `)
  await db.query(`
    CREATE TABLE public.cities (
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
    CREATE TABLE public.events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
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
      submitted_by uuid,
      llm_review_status public.llm_event_review_status NOT NULL DEFAULT 'not_required',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  await db.query(`
    CREATE TABLE public.tags (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      slug text NOT NULL UNIQUE,
      color text NOT NULL DEFAULT '#888888'
    )
  `)
  await db.query(`
    CREATE TABLE public.event_tags (
      event_id uuid NOT NULL REFERENCES public.events (id) ON DELETE CASCADE,
      tag_id uuid NOT NULL REFERENCES public.tags (id) ON DELETE CASCADE,
      PRIMARY KEY (event_id, tag_id)
    )
  `)
  await db.query(`
    CREATE TABLE public.ratings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL,
      event_id uuid NOT NULL REFERENCES public.events (id) ON DELETE CASCADE,
      score integer NOT NULL CHECK (score BETWEEN 1 AND 5),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, event_id)
    )
  `)
  await db.query(`
    CREATE TABLE public.favorites (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL,
      event_id uuid NOT NULL REFERENCES public.events (id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, event_id)
    )
  `)
  await db.query(`
    CREATE TABLE public.user_calendar_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL,
      event_id uuid NOT NULL REFERENCES public.events (id) ON DELETE CASCADE,
      notes text,
      added_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, event_id)
    )
  `)
  // U29: expanded to the latest legacy DDL (20260601006000 CREATE TABLE +
  // 20260601011000/20260601011001 ALTERs) — the pexels_*/pixabay_* columns,
  // download-tracking columns, and the (event_id, image_url) UNIQUE the
  // upsert RPC's ON CONFLICT needs. Perf-only indexes trimmed.
  await db.query(`
    CREATE TABLE public.event_image_attributions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id uuid NOT NULL REFERENCES public.events (id) ON DELETE CASCADE,
      image_url text NOT NULL,
      provider text NOT NULL DEFAULT 'unsplash'
        CONSTRAINT event_image_attributions_provider_check
        CHECK (provider IN ('pexels', 'pixabay', 'unsplash')),
      matched_tag text,
      unsplash_photo_id text,
      unsplash_photographer_name text,
      unsplash_photographer_username text,
      unsplash_photographer_profile_url text,
      unsplash_photo_url text,
      unsplash_download_location text,
      download_tracked_at timestamptz,
      download_tracking_status text NOT NULL DEFAULT 'pending'
        CHECK (download_tracking_status IN ('pending', 'succeeded', 'failed')),
      download_tracking_attempts integer NOT NULL DEFAULT 0
        CHECK (download_tracking_attempts >= 0),
      download_tracking_last_error text,
      download_tracking_next_attempt_at timestamptz NOT NULL DEFAULT now(),
      pexels_photo_id text,
      pexels_photographer_name text,
      pexels_photographer_profile_url text,
      pexels_photo_url text,
      pixabay_photo_id text,
      pixabay_photographer_name text,
      pixabay_photographer_username text,
      pixabay_photo_url text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT event_image_attributions_unique_image UNIQUE (event_id, image_url),
      CONSTRAINT event_image_attributions_provider_fields_check CHECK (
        (provider = 'unsplash' AND
          unsplash_photo_id IS NOT NULL AND
          unsplash_photographer_name IS NOT NULL AND
          unsplash_photographer_username IS NOT NULL AND
          unsplash_photographer_profile_url IS NOT NULL AND
          unsplash_photo_url IS NOT NULL AND
          unsplash_download_location IS NOT NULL)
        OR (provider = 'pexels' AND
          pexels_photo_id IS NOT NULL AND
          pexels_photographer_name IS NOT NULL AND
          pexels_photographer_profile_url IS NOT NULL AND
          pexels_photo_url IS NOT NULL)
        OR (provider = 'pixabay' AND
          pixabay_photo_id IS NOT NULL AND
          pixabay_photographer_name IS NOT NULL AND
          pixabay_photo_url IS NOT NULL)
      )
    )
  `)
  await db.query(`
    CREATE TABLE public.user_profiles (
      id uuid PRIMARY KEY,
      email text,
      display_name text,
      avatar_url text,
      role text NOT NULL DEFAULT 'user',
      city_preference_id uuid REFERENCES public.cities (id) ON DELETE SET NULL,
      child_name text,
      child_age integer,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT user_profiles_role_check CHECK (role = ANY (ARRAY['user'::text, 'admin'::text]))
    )
  `)
  await db.query(`
    CREATE TABLE public.comments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES public.user_profiles (id) ON DELETE CASCADE,
      event_id uuid NOT NULL REFERENCES public.events (id) ON DELETE CASCADE,
      body text NOT NULL,
      is_approved boolean NOT NULL DEFAULT true,
      is_flagged boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT comments_body_len_chk CHECK ((length(body) >= 1) AND (length(body) <= 4000))
    )
  `)
  await db.query(`
    CREATE TABLE public.user_preferred_cities (
      user_id uuid NOT NULL REFERENCES public.user_profiles (id) ON DELETE CASCADE,
      city_id uuid NOT NULL REFERENCES public.cities (id) ON DELETE CASCADE,
      is_primary boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, city_id)
    )
  `)
  await db.query(`
    CREATE UNIQUE INDEX user_preferred_cities_one_primary
      ON public.user_preferred_cities (user_id)
      WHERE is_primary
  `)
  for (const file of [
    "events_enriched.sql",
    "search_events.sql",
    "plan_events_for_user_range.sql",
  ]) {
    await db.query(readFileSync(join(SQL_DIR, file), "utf8"))
  }
}

export async function truncateCatalog(db: DbService): Promise<void> {
  await db.query(`TRUNCATE
    public.comments, public.user_preferred_cities, public.user_profiles,
    public.event_image_attributions, public.user_calendar_events, public.favorites,
    public.ratings, public.event_tags, public.tags, public.events, public.cities
    CASCADE`)
}
