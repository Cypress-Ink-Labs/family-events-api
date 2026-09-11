import { Injectable } from "@nestjs/common"

import { DbService } from "../db/db.service.js"
import { requireDatabaseAdmin, withAdminActor } from "./admin-database.js"
import { CRON_LABELS } from "./admin-cron.input.js"

@Injectable()
export class AdminCronRepository {
  constructor(private readonly db: DbService) {}

  gatesAndLatest(actor: string, labels: string[]): Promise<Record<string, unknown>[]> {
    return withAdminActor(this.db, actor, async (client) => {
      await requireDatabaseAdmin(client)
      const result = await client.query(
        `SELECT l.label,
                COALESCE(g.enabled, true) AS legacy_enabled,
                COALESCE(n.enabled, true) AS nest_enabled,
                r.id::text, r.status, r.ran_at::text, r.duration_s, r.http_status
           FROM unnest($1::text[]) AS l(label)
           LEFT JOIN private.cron_enabled g ON g.label = l.label
           LEFT JOIN private.cron_enabled n ON n.label = 'nestjs:' || l.label
           LEFT JOIN LATERAL (
             SELECT id, status, ran_at, duration_s, http_status
               FROM private.railway_cron_runs
              WHERE label = l.label ORDER BY ran_at DESC, id DESC LIMIT 1
           ) r ON true`,
        [labels]
      )
      return result.rows
    })
  }

  runs(actor: string, labels: string[], label: string | undefined, limit: number) {
    return withAdminActor(this.db, actor, async (client) => {
      await requireDatabaseAdmin(client)
      const result = await client.query(
        `SELECT id::text, label, status, ran_at::text, duration_s, http_status
           FROM private.railway_cron_runs
          WHERE label = ANY($1::text[]) AND ($2::text IS NULL OR label = $2)
          ORDER BY ran_at DESC, id DESC LIMIT $3`,
        [labels, label ?? null, limit]
      )
      return result.rows
    })
  }

  detail(actor: string, id: string) {
    return withAdminActor(this.db, actor, async (client) => {
      await requireDatabaseAdmin(client)
      const result = await client.query(
        `SELECT r.id::text, r.run_key::text, r.label, r.status, r.http_status,
                r.duration_s, r.body, r.ran_at::text,
                COALESCE(jsonb_agg(jsonb_build_object(
                  'id', e.id::text, 'provider', e.provider, 'level', e.level,
                  'message', e.message, 'metadata', e.metadata, 'sequence', e.sequence,
                  'created_at', e.created_at::text
                ) ORDER BY e.created_at, e.id) FILTER (WHERE e.id IS NOT NULL), '[]'::jsonb) AS logs
           FROM private.railway_cron_runs r
           LEFT JOIN private.cron_run_log_entries e ON e.run_key = r.run_key
          WHERE r.id = $1::bigint AND r.label = ANY($2::text[])
          GROUP BY r.id`,
        [id, CRON_LABELS]
      )
      return result.rows[0]
    })
  }
}
