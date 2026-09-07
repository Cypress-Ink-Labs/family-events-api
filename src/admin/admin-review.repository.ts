import { Injectable } from "@nestjs/common"
import type { PoolClient } from "pg"

import { DbService } from "../db/db.service.js"
import type {
  AdminEventsInput,
  AdminStatus,
  LlmReviewDecision,
  LlmReviewStatus,
} from "./admin-review.input.js"

export class AdminAccessDeniedError extends Error {
  constructor() {
    super("database admin access denied")
    this.name = "AdminAccessDeniedError"
  }
}

export interface AdminEventRow {
  id: string
  title: string
  status: AdminStatus
  start_datetime: string
  venue_name: string | null
  city_id: string | null
  source_id: string | null
  source_name: string | null
  is_free: boolean
  age_min: number | null
  age_max: number | null
  ai_confidence: string | null
  llm_review_status: LlmReviewStatus
  llm_review_decision: LlmReviewDecision | null
  llm_review_reason: string | null
  llm_review_error: string | null
  created_at: string
  total_count: string | number
}

export interface AdminFacetRow {
  city_id: string | null
  source_id: string | null
  status: AdminStatus
  count: string | number
}

// Acquire locks in one consistent order before the legacy RPC reads audit snapshots.
const LOCK_TARGETS_SQL =
  "SELECT id FROM public.events WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE"

const LIST_SQL = `
SELECT id, title, status, start_datetime, venue_name, city_id, source_id,
       source_name, is_free, age_min, age_max, ai_confidence, llm_review_status,
       llm_review_decision, llm_review_reason, llm_review_error, created_at, total_count
FROM public.admin_events_enriched(
  p_status => $1::text,
  p_city_id => $2::uuid,
  p_city_is_null => $3::boolean,
  p_keyword => $4::text,
  p_after_created_at => $5::timestamptz,
  p_after_id => $6::uuid,
  p_limit => $7::integer,
  p_llm_review_status => $8::public.llm_event_review_status,
  p_llm_review_decision => $9::public.llm_event_review_decision,
  p_llm_reviewed => $10::boolean,
  p_source_id => $11::uuid
)
`

@Injectable()
export class AdminReviewRepository {
  constructor(private readonly db: DbService) {}

  private withActor<T>(actor: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.db.withTransaction(async (client) => {
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: actor, role: "authenticated" }),
      ])
      return work(client)
    })
  }

  private async requireAdmin(client: PoolClient): Promise<void> {
    const result = await client.query<{ allowed: boolean | null }>(
      "SELECT private.is_admin() AS allowed"
    )
    if (result.rows[0]?.allowed !== true) throw new AdminAccessDeniedError()
  }

  listEvents(actor: string, input: AdminEventsInput): Promise<AdminEventRow[]> {
    return this.withActor(actor, async (client) => {
      const result = await client.query<AdminEventRow>(LIST_SQL, [
        input.status,
        input.cityId,
        input.cityIsNull,
        input.keyword,
        input.afterCreatedAt,
        input.afterId,
        input.limit,
        input.llmReviewStatus,
        input.llmReviewDecision,
        input.llmReviewed,
        input.sourceId,
      ])
      return result.rows
    })
  }

  facets(actor: string, keyword: string | null): Promise<AdminFacetRow[]> {
    return this.withActor(actor, async (client) => {
      const result = await client.query<AdminFacetRow>(
        "SELECT city_id, source_id, status, count FROM public.admin_event_facets($1::text)",
        [keyword]
      )
      return result.rows
    })
  }

  setStatus(
    actor: string,
    id: string,
    status: AdminStatus,
    reason: string | null
  ): Promise<number> {
    return this.withActor(actor, async (client) => {
      await client.query("SELECT public.admin_update_event_status($1::uuid, $2::text, $3::text)", [
        id,
        status,
        reason,
      ])
      return 1
    })
  }

  bulkStatus(actor: string, eventIds: string[], status: AdminStatus): Promise<number> {
    return this.withActor(actor, async (client) => {
      await this.requireAdmin(client)
      await client.query(LOCK_TARGETS_SQL, [eventIds])
      const result = await client.query<{ affected: number }>(
        "SELECT public.admin_batch_set_event_status($1::uuid[], $2::text) AS affected",
        [eventIds, status]
      )
      return result.rows[0]!.affected
    })
  }

  bulkDelete(actor: string, eventIds: string[]): Promise<number> {
    return this.withActor(actor, async (client) => {
      await this.requireAdmin(client)
      await client.query(LOCK_TARGETS_SQL, [eventIds])
      const result = await client.query<{ affected: number }>(
        "SELECT public.admin_delete_events($1::uuid[]) AS affected",
        [eventIds]
      )
      return result.rows[0]!.affected
    })
  }
}
