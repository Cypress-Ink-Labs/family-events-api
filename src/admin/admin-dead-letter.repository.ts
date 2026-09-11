import { Injectable } from "@nestjs/common"
import type { PoolClient } from "pg"

import { DbService } from "../db/db.service.js"
import { requireDatabaseAdmin, withAdminActor } from "./admin-database.js"
import type { DeadLetterListInput, DeadLetterQueue } from "./admin-dead-letter.input.js"

export interface DeadLetterRow {
  id: string
  attempt_count: number
  enqueued_at: string
  started_at: string | null
  finished_at: string | null
  next_attempt_at: string
  last_error: string | null
  trigger_type: string
  source_id: string | null
  source_run_id: string | null
  event_id: string | null
}
export interface DeadLetterRetryResult {
  disposition: "queued" | "already_active"
  resultingQueueId: string
}

const TABLES = {
  source: {
    name: "source_scrape_queue",
    columns: "source_id, source_run_id, NULL::uuid AS event_id",
  },
  tag: {
    name: "event_tag_queue",
    columns: "NULL::uuid AS source_id, source_run_id, event_id",
  },
} as const

@Injectable()
export class AdminDeadLetterRepository {
  constructor(private readonly db: DbService) {}

  list(actor: string, input: DeadLetterListInput): Promise<DeadLetterRow[]> {
    const table = TABLES[input.queue]
    const cursorPredicate =
      input.cursor === null
        ? "TRUE"
        : input.cursor.finishedAt === null
          ? "finished_at IS NULL AND id < $2::bigint"
          : "(finished_at < $1::timestamptz OR finished_at IS NULL OR (finished_at = $1::timestamptz AND id < $2::bigint))"
    return withAdminActor(this.db, actor, async (client) => {
      await requireDatabaseAdmin(client)
      const result = await client.query<DeadLetterRow>(
        `SELECT id::text AS id, attempt_count, enqueued_at, started_at, finished_at,
                next_attempt_at, left(last_error, 1000) AS last_error, trigger_type, ${table.columns}
         FROM public.${table.name}
         WHERE status = 'dead' AND ${cursorPredicate}
         ORDER BY finished_at DESC NULLS LAST, id DESC
         LIMIT $3::integer`,
        [input.cursor?.finishedAt ?? null, input.cursor?.id ?? null, input.limit + 1]
      )
      return result.rows
    })
  }

  retry(actor: string, queue: DeadLetterQueue, id: string): Promise<DeadLetterRetryResult | null> {
    const table = TABLES[queue]
    return withAdminActor(this.db, actor, async (client) => {
      await requireDatabaseAdmin(client)
      const snapshot = await this.lockDead(client, queue, id)
      if (snapshot === null) return null
      const entityId = queue === "source" ? snapshot.source_id! : snapshot.event_id!
      const activeBefore = await this.findActive(client, queue, entityId)
      const rpc =
        queue === "source"
          ? "SELECT public.admin_retry_source_scrape_queue($1::bigint) AS ok"
          : "SELECT public.admin_retry_dead_tag_queue($1::bigint) AS ok"
      const result = await client.query<{ ok: boolean }>(rpc, [id])
      if (result.rows[0]?.ok !== true) return null
      const active = activeBefore ?? (await this.findActive(client, queue, entityId))
      if (active === null) return null
      await this.audit(
        client,
        "dead_letter.retry",
        table.name,
        queue,
        snapshot,
        active.id,
        active.status
      )
      return {
        disposition: activeBefore === null ? "queued" : "already_active",
        resultingQueueId: active.id,
      }
    })
  }

  remove(actor: string, queue: DeadLetterQueue, id: string): Promise<boolean> {
    const table = TABLES[queue]
    return withAdminActor(this.db, actor, async (client) => {
      await requireDatabaseAdmin(client)
      const snapshot = await this.lockDead(client, queue, id)
      if (snapshot === null) return false
      const rpc =
        queue === "source"
          ? "SELECT public.admin_delete_dead_source_queue($1::bigint) AS ok"
          : "SELECT public.admin_delete_dead_tag_queue($1::bigint) AS ok"
      const deleted = await client.query<{ ok: boolean }>(rpc, [id])
      if (deleted.rows[0]?.ok !== true) return false
      await this.audit(client, "dead_letter.delete", table.name, queue, snapshot)
      return true
    })
  }

  private async lockDead(
    client: PoolClient,
    queue: DeadLetterQueue,
    id: string
  ): Promise<DeadLetterRow | null> {
    const table = TABLES[queue]
    const result = await client.query<DeadLetterRow>(
      `SELECT id::text AS id, attempt_count, enqueued_at, started_at, finished_at,
              next_attempt_at, last_error, trigger_type, ${table.columns}
       FROM public.${table.name}
       WHERE id = $1::bigint AND status = 'dead' FOR UPDATE`,
      [id]
    )
    return result.rows[0] ?? null
  }

  private async findActive(client: PoolClient, queue: DeadLetterQueue, entityId: string) {
    const table = TABLES[queue]
    const column = queue === "source" ? "source_id" : "event_id"
    const result = await client.query<{ id: string; status: string }>(
      `SELECT id::text AS id, status::text AS status FROM public.${table.name}
       WHERE ${column} = $1::uuid AND status IN ('pending','processing'${queue === "source" ? ",'retrying'" : ""})
       ORDER BY id DESC LIMIT 1`,
      [entityId]
    )
    return result.rows[0] ?? null
  }

  private async audit(
    client: PoolClient,
    action: string,
    targetType: string,
    queue: DeadLetterQueue,
    row: DeadLetterRow,
    resultingQueueId?: string,
    resultingStatus?: string
  ): Promise<void> {
    const metadata = {
      queue,
      original_id: row.id,
      old_status: "dead",
      old_attempt_count: row.attempt_count,
      old_error: row.last_error,
      source_id: row.source_id,
      source_run_id: row.source_run_id,
      event_id: row.event_id,
      ...(resultingQueueId === undefined
        ? {}
        : { resulting_queue_id: resultingQueueId, resulting_status: resultingStatus }),
    }
    await client.query(
      `INSERT INTO public.admin_audit_log (admin_user_id, action, target_type, metadata)
       VALUES (auth.uid(), $1::text, $2::text, $3::jsonb)`,
      [action, targetType, JSON.stringify(metadata)]
    )
  }
}
