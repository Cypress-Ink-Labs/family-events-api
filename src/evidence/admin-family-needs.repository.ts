import { Injectable } from "@nestjs/common"
import { requireDatabaseAdmin, withAdminActor } from "../admin/admin-database.js"
import { DbService } from "../db/db.service.js"
import type {
  FamilyNeedEvidenceInput,
  FamilyNeedReassessmentInput,
} from "./admin-family-needs.input.js"

export interface FamilyNeedEvidenceRow {
  id: string
  event_id: string
  claim: string
  value: string
  provenance_type: string
  source_url: string | null
  statement: string
  observed_at: string
  recorded_at: string
  recorded_by: string | null
  applicable_venue_name: string | null
  applicable_address: string | null
  applicable_start_datetime: string | null
  applicable_end_datetime: string | null
  invalidated_at: string | null
  invalidation_reason: string | null
  has_conflict?: boolean
}

const COLUMNS = `id::text, event_id::text, claim::text, value::text, provenance_type::text,
  source_url, statement, observed_at, recorded_at, recorded_by::text,
  applicable_venue_name, applicable_address, applicable_start_datetime, applicable_end_datetime,
  invalidated_at, invalidation_reason`

@Injectable()
export class AdminFamilyNeedsRepository {
  constructor(private readonly db: DbService) {}

  async add(
    eventId: string,
    actor: string,
    input: FamilyNeedEvidenceInput
  ): Promise<FamilyNeedEvidenceRow> {
    return withAdminActor(this.db, actor, async (client) => {
      await requireDatabaseAdmin(client)
      const result = await client.query<FamilyNeedEvidenceRow>(
        `INSERT INTO public.event_family_need_evidence
          (event_id, claim, value, provenance_type, source_url, statement, observed_at, recorded_by,
           applicable_venue_name, applicable_address, applicable_start_datetime, applicable_end_datetime)
         SELECT id, $2, $3, $4, $5, $6, $7, $8, venue_name, address, start_datetime, end_datetime
         FROM public.events WHERE id = $1::uuid
         RETURNING ${COLUMNS}`,
        [
          eventId,
          input.claim,
          input.value,
          input.provenance_type,
          input.source_url ?? null,
          input.statement,
          input.observed_at,
          actor,
        ]
      )
      if (!result.rows[0]) throw new Error("EVENT_NOT_FOUND")
      return result.rows[0]
    })
  }

  async invalidate(
    eventId: string,
    actor: string,
    input: FamilyNeedReassessmentInput
  ): Promise<FamilyNeedEvidenceRow> {
    return withAdminActor(this.db, actor, async (client) => {
      await requireDatabaseAdmin(client)
      const result = await client.query<FamilyNeedEvidenceRow>(
        `UPDATE public.event_family_need_evidence
         SET invalidated_at = clock_timestamp(), invalidation_reason = $3
         WHERE event_id = $1::uuid AND id = $2::uuid AND invalidated_at IS NULL
         RETURNING ${COLUMNS}`,
        [eventId, input.evidence_id, input.reason]
      )
      if (!result.rows[0]) throw new Error("EVIDENCE_NOT_FOUND")
      return result.rows[0]
    })
  }

  async list(eventId: string, actor: string): Promise<FamilyNeedEvidenceRow[]> {
    return withAdminActor(this.db, actor, async (client) => {
      await requireDatabaseAdmin(client)
      const event = await client.query("SELECT 1 FROM public.events WHERE id = $1::uuid", [eventId])
      if (event.rowCount === 0) throw new Error("EVENT_NOT_FOUND")
      const result = await client.query<FamilyNeedEvidenceRow>(
        `SELECT ${COLUMNS},
           CASE WHEN invalidated_at IS NULL THEN EXISTS (
             SELECT 1
             FROM public.event_family_need_evidence conflict
             WHERE conflict.event_id = evidence.event_id
               AND conflict.claim = evidence.claim
               AND conflict.invalidated_at IS NULL
               AND conflict.value <> evidence.value
           ) ELSE false END AS has_conflict
         FROM public.event_family_need_evidence evidence
         WHERE event_id = $1::uuid
         ORDER BY claim, observed_at DESC, recorded_at DESC, id DESC`,
        [eventId]
      )
      return result.rows
    })
  }
}
