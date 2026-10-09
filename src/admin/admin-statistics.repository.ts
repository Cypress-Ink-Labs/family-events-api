import { Injectable } from "@nestjs/common"

import { DbService } from "../db/db.service.js"
import { requireDatabaseAdmin, withAdminActor } from "./admin-database.js"

@Injectable()
export class AdminStatisticsRepository {
  constructor(private readonly db: DbService) {}

  dashboard(actor: string): Promise<unknown> {
    return withAdminActor(this.db, actor, async (client) => {
      await requireDatabaseAdmin(client)
      const result = await client.query<{ stats: unknown }>(
        "SELECT public.admin_dashboard_stats() AS stats"
      )
      return result.rows[0]?.stats
    })
  }

  pipeline(actor: string, windowDays: number): Promise<unknown> {
    return withAdminActor(this.db, actor, async (client) => {
      await requireDatabaseAdmin(client)
      const result = await client.query<{ stats: unknown }>(
        `WITH reviews AS (
  SELECT
    count(*) FILTER (WHERE t.status = 'succeeded') AS llm_reviewed,
    count(*) FILTER (WHERE 'source_auto_rejected' = ANY(t.flags)) AS auto_rejected,
    count(*) FILTER (WHERE 'memory_context_used' = ANY(t.flags)) AS memory_hits
  FROM public.event_llm_review_traces t
  WHERE t.created_at >= now() - ($1::int || ' days')::interval
)
SELECT jsonb_build_object(
    'window_days', $1::int,
    'total_reviewed', (
      SELECT count(*) FROM public.events e
      WHERE e.status IN ('published'::public.event_status, 'rejected'::public.event_status)
        AND e.updated_at >= now() - ($1::int || ' days')::interval
    ),
    'llm_reviewed', reviews.llm_reviewed,
    'admin_reviewed', (
      SELECT count(*) FROM public.admin_event_decisions d
      WHERE d.decision_type IN ('status_change', 'status_and_tags')
        AND d.created_at >= now() - ($1::int || ' days')::interval
    ),
    'auto_rejected', reviews.auto_rejected,
    'memory_hits', reviews.memory_hits,
    'total_embeddings', (SELECT count(*) FROM public.event_embeddings),
    'tag_memory_hits', (
      SELECT count(*) FILTER (
        WHERE t.created_at >= now() - ($1::int || ' days')::interval
          AND t.predicted_fields->'memory_context'->>'used' = 'true'
      ) FROM public.event_ai_traces t
    ),
    'top_rejection_sources', (
      SELECT COALESCE(jsonb_agg(src ORDER BY src->>'rejection_rate' DESC), '[]'::jsonb)
      FROM (
        SELECT jsonb_build_object(
          'source_id', e.source_id,
          'source_name', max(e.source_name),
          'total', count(*),
          'rejected', count(*) FILTER (WHERE e.status = 'rejected'::public.event_status),
          'rejection_rate', round(
            (count(*) FILTER (WHERE e.status = 'rejected'::public.event_status))::numeric
            / GREATEST(count(*), 1) * 100, 1
          )
        ) AS src
        FROM public.events e
        WHERE e.source_id IS NOT NULL
          AND e.status IN ('published'::public.event_status, 'rejected'::public.event_status)
          AND e.updated_at >= now() - ($1::int || ' days')::interval
        GROUP BY e.source_id
        HAVING count(*) >= 3
        ORDER BY (count(*) FILTER (WHERE e.status = 'rejected'::public.event_status))::float
          / GREATEST(count(*), 1) DESC
        LIMIT 10
      ) sub
    ),
    'feature_flags', (
      SELECT COALESCE(jsonb_object_agg(ac.feature, ac.enabled), '{}'::jsonb)
      FROM public.ai_feature_config ac
      WHERE ac.feature IN ('tag-memory', 'review-memory', 'source-auto-reject')
    )
  ) AS stats FROM reviews`,
        [windowDays]
      )
      return result.rows[0]?.stats
    })
  }
}
