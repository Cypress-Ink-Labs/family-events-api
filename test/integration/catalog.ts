import type { DbService } from "../../src/db/db.service.js"

/**
 * Minimal public-schema objects the U23 repositories read.
 * Column names and published-only status match family-events-backend.
 */
export async function ensureCatalogSchema(db: DbService): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS public.cities (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      slug text NOT NULL UNIQUE,
      state text,
      country text NOT NULL DEFAULT 'US',
      timezone text NOT NULL,
      latitude double precision,
      longitude double precision,
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
      latitude double precision,
      longitude double precision,
      age_min integer,
      age_max integer,
      price numeric,
      is_free boolean NOT NULL DEFAULT false,
      is_featured boolean NOT NULL DEFAULT false,
      is_outdoor boolean,
      images jsonb NOT NULL DEFAULT '[]'::jsonb,
      source_url text,
      status text NOT NULL CHECK (status IN ('draft', 'published', 'rejected', 'archived'))
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS public.tags (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      slug text NOT NULL UNIQUE,
      color text NOT NULL DEFAULT '#888888',
      category text NOT NULL DEFAULT 'general',
      is_system boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS public.event_tags (
      event_id uuid NOT NULL REFERENCES public.events (id) ON DELETE CASCADE,
      tag_id uuid NOT NULL REFERENCES public.tags (id) ON DELETE CASCADE,
      PRIMARY KEY (event_id, tag_id)
    )
  `)
}

export async function truncateCatalog(db: DbService): Promise<void> {
  await db.query("TRUNCATE public.event_tags, public.tags, public.events, public.cities CASCADE")
}
