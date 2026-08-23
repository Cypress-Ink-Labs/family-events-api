import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { DbService } from "../../src/db/db.service.js"

import { ensureCatalogSchema } from "./catalog.js"

/**
 * Installs the ingestion-side schema on top of the consumer catalog (U28):
 * the tables the scrape pipeline reads and writes (event_sources, source_runs,
 * source_scrape_queue, source_extraction_traces, event_tag_queue,
 * event_llm_review_queue, admin_audit_log) plus the events columns the bulk
 * import RPC touches (llm_review_*, admin_locked_fields) and its ON CONFLICT
 * target index. Column names, types, CHECKs, and partial unique indexes match
 * family-events-backend's migrations (schema baseline + 20260601004000 llm
 * review + 20260620000000 stale escalation + 20260816000000 stale status).
 *
 * U29 adds the classification-side tables the tagging/memory-context seams
 * read and write: event_ai_traces (baseline + prompt_version from
 * 20260601005000), admin_event_decisions (20260601021000), ai_feature_config +
 * approved_ai_models (20260601005000; that file contains duplicate CREATE
 * TABLE blocks from re-runs — both are identical), the baseline event_tags
 * classification columns (confidence / is_manual_override / created_at), and
 * the baseline events ai_tag_model / ai_tag_status columns. RLS policies,
 * GRANT/REVOKE, and non-behavioral indexes are trimmed (no anon/authenticated/
 * service_role roles here). The tables' updated_by/admin_user_id columns FK to
 * auth.users, so a minimal auth.users stub is installed first.
 *
 * RPCs are extracted VERBATIM from the backend migrations into
 * test/integration/sql/ (GRANT/REVOKE trimmed — no anon/authenticated/
 * service_role roles here):
 *
 * - bulk_import_scrape_events.sql
 *     <- private def from 20260601017000, public wrapper from 20260601002000
 * - find_cross_source_event_candidates.sql <- 20260620010000
 * - source_scrape_queue_rpcs.sql <- schema baseline (claim/mark/retry/release/
 *   reap queue RPCs, run_due_source_scrapes, run_cleanup_stale_runs)
 * - event_tag_queue_rpcs.sql <- schema baseline (claim/mark-started/release/
 *   reap tag queue RPCs, U29)
 *
 * Deviation: public.invoke_process_tag_queue is a no-op stub here — the real
 * function fires net.http_post (pg_net) at the deployed process-tag-queue edge
 * function, which a disposable test database can neither install nor reach.
 * The import path treats kick failures as non-fatal either way.
 */
const SQL_DIR = join(process.cwd(), "test", "integration", "sql")

export async function ensureIngestionSchema(db: DbService): Promise<void> {
  await ensureCatalogSchema(db)

  await db.query(`
    DROP TABLE IF EXISTS
      public.ai_feature_config, public.approved_ai_models, public.admin_event_decisions,
      public.event_ai_traces, public.admin_audit_log, public.event_llm_review_traces,
      public.event_llm_review_queue, public.event_tag_queue, public.source_extraction_traces,
      public.source_scrape_queue, public.source_runs, public.event_sources
    CASCADE
  `)
  await db.query("DROP TYPE IF EXISTS public.source_extraction_mode CASCADE")
  await db.query("DROP TYPE IF EXISTS public.event_processing_mode CASCADE")
  await db.query("DROP TYPE IF EXISTS public.llm_event_review_status CASCADE")
  await db.query("DROP TYPE IF EXISTS public.llm_event_review_decision CASCADE")
  await db.query("DROP TYPE IF EXISTS public.llm_event_review_queue_status CASCADE")
  await db.query("DROP TYPE IF EXISTS public.event_tag_queue_status CASCADE")
  await db.query("DROP TYPE IF EXISTS public.source_scrape_queue_status CASCADE")

  await db.query(`
    CREATE TYPE public.source_extraction_mode AS ENUM (
      'deterministic', 'llm', 'deterministic_then_llm'
    )
  `)
  await db.query(`
    CREATE TYPE public.event_processing_mode AS ENUM (
      'manual_review', 'auto_approve', 'llm_review'
    )
  `)
  await db.query(`
    CREATE TYPE public.llm_event_review_status AS ENUM (
      'not_required', 'pending', 'succeeded', 'failed', 'skipped'
    )
  `)
  await db.query(`
    CREATE TYPE public.llm_event_review_decision AS ENUM (
      'approve', 'reject', 'needs_admin_review'
    )
  `)
  await db.query(`
    CREATE TYPE public.llm_event_review_queue_status AS ENUM (
      'pending', 'processing', 'retrying', 'succeeded', 'dead'
    )
  `)
  await db.query(`
    CREATE TYPE public.event_tag_queue_status AS ENUM (
      'pending', 'processing', 'failed', 'dead', 'succeeded'
    )
  `)
  await db.query(`
    CREATE TYPE public.source_scrape_queue_status AS ENUM (
      'pending', 'processing', 'retrying', 'succeeded', 'dead'
    )
  `)

  // Events columns written by bulk_import_scrape_events (20260601004000) and
  // the admin field-lock feature, plus its ON CONFLICT (source_id, source_url)
  // partial unique index. ai_tag_model / ai_tag_status come from the schema
  // baseline and are written by the tag-event update (U29); CHECKs trimmed
  // like the llm_review_* block above.
  await db.query(`
    ALTER TABLE public.events
      ADD COLUMN IF NOT EXISTS llm_review_status public.llm_event_review_status
        NOT NULL DEFAULT 'not_required'::public.llm_event_review_status,
      ADD COLUMN IF NOT EXISTS llm_review_decision public.llm_event_review_decision,
      ADD COLUMN IF NOT EXISTS llm_review_confidence numeric(4,3),
      ADD COLUMN IF NOT EXISTS llm_review_reason text,
      ADD COLUMN IF NOT EXISTS llm_review_flags text[] DEFAULT '{}'::text[] NOT NULL,
      ADD COLUMN IF NOT EXISTS llm_review_provider text,
      ADD COLUMN IF NOT EXISTS llm_review_model text,
      ADD COLUMN IF NOT EXISTS llm_review_prompt_version text,
      ADD COLUMN IF NOT EXISTS llm_reviewed_at timestamptz,
      ADD COLUMN IF NOT EXISTS llm_review_error text,
      ADD COLUMN IF NOT EXISTS admin_locked_fields text[] DEFAULT '{}'::text[] NOT NULL,
      ADD COLUMN IF NOT EXISTS ai_tag_model text,
      ADD COLUMN IF NOT EXISTS ai_tag_status text
  `)
  // event_tags classification columns from the schema baseline (the U28
  // catalog predates classification and creates only event_id/tag_id).
  await db.query(`
    ALTER TABLE public.event_tags
      ADD COLUMN IF NOT EXISTS confidence numeric(4,3) DEFAULT 1.0 NOT NULL,
      ADD COLUMN IF NOT EXISTS is_manual_override boolean DEFAULT false NOT NULL,
      ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now() NOT NULL
  `)
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS events_source_id_source_url_uniq
      ON public.events (source_id, source_url)
      WHERE source_url IS NOT NULL
  `)

  await db.query(`
    CREATE TABLE public.event_sources (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      url text NOT NULL,
      source_type text NOT NULL DEFAULT 'website',
      city_id uuid REFERENCES public.cities (id),
      is_active boolean NOT NULL DEFAULT true,
      scrape_interval_hours integer NOT NULL DEFAULT 24,
      last_scraped_at timestamptz,
      last_status text DEFAULT 'pending',
      error_count integer NOT NULL DEFAULT 0,
      notes text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      auto_approve boolean NOT NULL DEFAULT false,
      date_window_days integer,
      extraction_mode public.source_extraction_mode NOT NULL DEFAULT 'deterministic',
      processing_mode public.event_processing_mode,
      consecutive_zero_result_scrapes integer NOT NULL DEFAULT 0,
      stale_escalated_at timestamptz,
      CONSTRAINT event_sources_last_status_check CHECK (last_status = ANY (ARRAY[
        'pending'::text, 'success'::text, 'error'::text, 'partial'::text, 'stale'::text
      ])),
      CONSTRAINT event_sources_source_type_check CHECK (source_type = ANY (ARRAY[
        'website'::text, 'ical'::text, 'rss'::text, 'manual'::text, 'macaronikid'::text,
        'brec'::text, 'downtownlafayette'::text, 'lcglafayette'::text, 'localhop'::text
      ]))
    )
  `)
  await db.query(`
    ALTER TABLE public.events
      ADD CONSTRAINT events_source_id_fkey
      FOREIGN KEY (source_id) REFERENCES public.event_sources (id) ON DELETE SET NULL
  `)
  await db.query(`
    CREATE TABLE public.source_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      source_id uuid REFERENCES public.event_sources (id) ON DELETE SET NULL,
      started_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      status text NOT NULL DEFAULT 'running',
      events_found integer NOT NULL DEFAULT 0,
      events_imported integer NOT NULL DEFAULT 0,
      events_skipped integer NOT NULL DEFAULT 0,
      error_log text,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT source_runs_status_check CHECK (status = ANY (ARRAY[
        'running'::text, 'success'::text, 'error'::text, 'partial'::text
      ]))
    )
  `)
  await db.query(`
    CREATE TABLE public.source_scrape_queue (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      source_id uuid,
      source_run_id uuid,
      status public.source_scrape_queue_status NOT NULL DEFAULT 'pending',
      trigger_type text NOT NULL DEFAULT 'manual',
      attempt_count integer NOT NULL DEFAULT 0,
      enqueued_at timestamptz NOT NULL DEFAULT now(),
      started_at timestamptz,
      finished_at timestamptz,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      last_error text,
      skip_reason text,
      CONSTRAINT source_scrape_queue_trigger_type_check CHECK (trigger_type = ANY (ARRAY[
        'manual'::text, 'scheduled'::text, 'bulk'::text, 'retry'::text
      ]))
    )
  `)
  // Active-row dedup guard used by enqueue_source_scrape / run_due_source_scrapes
  // ON CONFLICT DO NOTHING (one live queue row per source) — verbatim from the
  // schema baseline, as is the claimable index the SKIP LOCKED claim scans.
  await db.query(`
    CREATE UNIQUE INDEX source_scrape_queue_source_active_uniq
      ON public.source_scrape_queue (source_id)
      WHERE source_id IS NOT NULL AND status = ANY (ARRAY[
        'pending'::public.source_scrape_queue_status,
        'processing'::public.source_scrape_queue_status,
        'retrying'::public.source_scrape_queue_status
      ])
  `)
  await db.query(`
    CREATE INDEX source_scrape_queue_claimable_idx
      ON public.source_scrape_queue (next_attempt_at, id)
      WHERE status = ANY (ARRAY[
        'pending'::public.source_scrape_queue_status,
        'retrying'::public.source_scrape_queue_status
      ])
  `)
  await db.query(`
    CREATE TABLE public.source_extraction_traces (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      source_queue_id bigint,
      source_run_id uuid,
      source_id uuid,
      extraction_mode public.source_extraction_mode NOT NULL,
      extractor text NOT NULL,
      provider text,
      model text,
      status text NOT NULL,
      input_bytes integer,
      parsed_event_count integer NOT NULL DEFAULT 0,
      fallback_reason text,
      latency_ms integer,
      reasoning_summary text,
      error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT source_extraction_traces_extractor_check
        CHECK (extractor = ANY (ARRAY['deterministic'::text, 'llm'::text])),
      CONSTRAINT source_extraction_traces_status_check
        CHECK (status = ANY (ARRAY['success'::text, 'fallback'::text, 'error'::text]))
    )
  `)
  await db.query(`
    CREATE TABLE public.event_tag_queue (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      event_id uuid NOT NULL,
      source_run_id uuid,
      trigger_type text NOT NULL DEFAULT 'import',
      enqueued_at timestamptz NOT NULL DEFAULT now(),
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      started_at timestamptz,
      finished_at timestamptz,
      attempt_count integer NOT NULL DEFAULT 0,
      last_error text,
      status public.event_tag_queue_status NOT NULL DEFAULT 'pending',
      CONSTRAINT event_tag_queue_trigger_type_check CHECK (trigger_type = ANY (ARRAY[
        'import'::text, 'reclassify'::text, 'manual-review'::text
      ]))
    )
  `)
  await db.query(`
    CREATE UNIQUE INDEX event_tag_queue_event_active_uniq
      ON public.event_tag_queue (event_id)
      WHERE status = ANY (ARRAY[
        'pending'::public.event_tag_queue_status,
        'processing'::public.event_tag_queue_status
      ])
  `)
  await db.query(`
    CREATE TABLE public.event_llm_review_queue (
      id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      event_id uuid NOT NULL REFERENCES public.events (id) ON DELETE CASCADE,
      source_id uuid REFERENCES public.event_sources (id) ON DELETE SET NULL,
      source_run_id uuid REFERENCES public.source_runs (id) ON DELETE SET NULL,
      trigger_type text NOT NULL DEFAULT 'import',
      status public.llm_event_review_queue_status NOT NULL DEFAULT 'pending',
      attempt_count integer NOT NULL DEFAULT 0,
      max_attempts integer NOT NULL DEFAULT 3,
      enqueued_at timestamptz NOT NULL DEFAULT now(),
      started_at timestamptz,
      finished_at timestamptz,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  await db.query(`
    CREATE UNIQUE INDEX event_llm_review_queue_active_event_idx
      ON public.event_llm_review_queue (event_id)
      WHERE status IN ('pending', 'processing', 'retrying')
  `)
  await db.query(`
    CREATE TABLE public.event_llm_review_traces (
      id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      event_id uuid NOT NULL REFERENCES public.events (id) ON DELETE CASCADE,
      queue_id bigint REFERENCES public.event_llm_review_queue (id) ON DELETE SET NULL,
      source_id uuid REFERENCES public.event_sources (id) ON DELETE SET NULL,
      source_run_id uuid REFERENCES public.source_runs (id) ON DELETE SET NULL,
      provider text,
      model text,
      prompt_version text NOT NULL,
      status public.llm_event_review_status NOT NULL,
      model_decision public.llm_event_review_decision,
      applied_decision public.llm_event_review_decision,
      confidence numeric(4,3),
      reason text,
      flags text[] NOT NULL DEFAULT '{}'::text[],
      suggested_category text,
      normalized_title text,
      raw_response jsonb,
      error_code text,
      error_message text,
      input_snapshot jsonb,
      processing_ms integer,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  await db.query(`
    CREATE TABLE public.admin_audit_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      admin_user_id uuid,
      action text NOT NULL,
      target_type text,
      target_id uuid,
      metadata jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `)

  // Minimal stub for the auth.users FKs below (ai_feature_config.updated_by,
  // admin_event_decisions.admin_user_id) — same convention as
  // identity.integration.test.ts.
  await db.query("CREATE SCHEMA IF NOT EXISTS auth")
  await db.query("CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY)")

  // Classification trace rows written by tag-event — verbatim from the schema
  // baseline, with prompt_version folded in from 20260601005000 (both of that
  // file's duplicate ADD COLUMN blocks are identical). event_id is a bare uuid
  // in the real schema (no FK), so queue-side deletes never cascade here.
  await db.query(`
    CREATE TABLE public.event_ai_traces (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id uuid NOT NULL,
      source_run_id uuid,
      trigger_type text NOT NULL DEFAULT 'import',
      provider text,
      model text,
      status text NOT NULL DEFAULT 'success',
      input_title text NOT NULL,
      input_description text,
      available_tag_slugs jsonb NOT NULL DEFAULT '[]'::jsonb,
      predicted_tags jsonb NOT NULL DEFAULT '[]'::jsonb,
      predicted_fields jsonb,
      reasoning_summary text,
      fallback_reason text,
      processing_ms integer,
      prompt_version text,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT event_ai_traces_provider_check CHECK (
        (provider IS NULL) OR (provider = ANY (ARRAY[
          'openai'::text, 'ollama'::text, 'localai'::text
        ]))
      ),
      CONSTRAINT event_ai_traces_status_check CHECK (status = ANY (ARRAY[
        'success'::text, 'fallback'::text, 'error'::text
      ])),
      CONSTRAINT event_ai_traces_trigger_type_check CHECK (trigger_type = ANY (ARRAY[
        'import'::text, 'reclassify'::text, 'manual-review'::text
      ]))
    )
  `)
  // Admin decisions feed memory-context's few-shot prompts — verbatim from
  // 20260601021000 (its perf indexes trimmed; nothing behavioral).
  await db.query(`
    CREATE TABLE public.admin_event_decisions (
      id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      event_id uuid NOT NULL REFERENCES public.events (id) ON DELETE CASCADE,
      admin_user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
      decision_type text NOT NULL
        CHECK (decision_type IN ('status_change', 'tag_edit', 'status_and_tags')),
      old_status public.event_status,
      new_status public.event_status,
      old_tags jsonb,
      new_tags jsonb,
      reason text,
      source_context jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  // AI model allowlist + per-feature config. CREATE TABLEs verbatim from
  // 20260601005000 (that file re-runs the same blocks twice; identical; seed
  // INSERTs / RLS / GRANTs trimmed) EXCEPT the feature CHECK, which
  // 20260601020000 replaces to also allow 'parent-tips' and the memory
  // feature flags getMemoryFeatureFlag reads ('tag-memory', 'review-memory',
  // 'source-auto-reject'). The gpt-5 statements in 05000 are data updates,
  // not DDL — test seeds own their rows.
  await db.query(`
    CREATE TABLE public.approved_ai_models (
      id text PRIMARY KEY,
      provider text NOT NULL CHECK (provider IN ('openai', 'ollama', 'localai')),
      display_name text NOT NULL,
      description text NOT NULL DEFAULT '',
      cost_tier text NOT NULL DEFAULT 'medium'
        CHECK (cost_tier IN ('low', 'medium', 'high')),
      is_enabled bool NOT NULL DEFAULT true
    )
  `)
  await db.query(`
    CREATE TABLE public.ai_feature_config (
      feature text PRIMARY KEY
        CONSTRAINT ai_feature_config_feature_check CHECK (feature IN (
          'tagging'::text, 'event-review'::text, 'parent-tips'::text,
          'tag-memory'::text, 'review-memory'::text, 'source-auto-reject'::text
        )),
      model_id text NOT NULL REFERENCES public.approved_ai_models (id),
      enabled bool NOT NULL DEFAULT true,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by uuid REFERENCES auth.users (id)
    )
  `)

  await db.query("CREATE SCHEMA IF NOT EXISTS private")
  await db.query(`
    CREATE OR REPLACE FUNCTION public.invoke_process_tag_queue() RETURNS void
    LANGUAGE sql AS 'SELECT NULL::void'
  `)
  for (const file of [
    "bulk_import_scrape_events.sql",
    "find_cross_source_event_candidates.sql",
    "source_scrape_queue_rpcs.sql",
    "event_tag_queue_rpcs.sql",
    "event_llm_review_queue_rpcs.sql",
  ]) {
    await db.query(readFileSync(join(SQL_DIR, file), "utf8"))
  }
}

export async function truncateIngestion(db: DbService): Promise<void> {
  await db.query(`TRUNCATE
    public.ai_feature_config, public.approved_ai_models, public.admin_event_decisions,
    public.event_ai_traces, public.admin_audit_log, public.event_llm_review_traces,
    public.event_llm_review_queue, public.event_tag_queue, public.source_extraction_traces,
    public.source_scrape_queue, public.source_runs, public.event_sources, public.event_tags,
    public.tags, public.events, public.cities
    CASCADE`)
}
