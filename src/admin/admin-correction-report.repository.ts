import { Injectable } from "@nestjs/common"

import { DbService } from "../db/db.service.js"
import { requireDatabaseAdmin, withAdminActor } from "./admin-database.js"

export interface CorrectionReportRow {
  id: string
  event_id: string
  reporter_user_id: string | null
  category: string
  details: string
  priority: number
  status: string
  version: number
  claimed_by: string | null
  claimed_at: string | null
  resolved_by: string | null
  resolved_at: string | null
  resolution_note: string | null
  correction_id: string | null
  created_at: string
  updated_at: string
}

export type CorrectionReportListRow = Omit<
  CorrectionReportRow,
  "reporter_user_id" | "details" | "resolution_note"
>

export interface ListingCorrectionRow {
  id: string
  event_id: string
  operator_id: string
  audit_log_id: string
  audit_note: string
  created_at: string
}

@Injectable()
export class AdminCorrectionReportRepository {
  constructor(private readonly db: DbService) {}

  list(
    actor: string,
    status: string | undefined,
    limit: number
  ): Promise<CorrectionReportListRow[]> {
    return withAdminActor(this.db, actor, async (client) => {
      await requireDatabaseAdmin(client)
      const result = await client.query<CorrectionReportListRow>(
        `SELECT id,event_id,category,priority,status,version,
                claimed_by,claimed_at,resolved_by,resolved_at,correction_id,
                created_at,updated_at
         FROM public.correction_reports
         WHERE ($1::correction_report_status IS NULL OR status = $1)
         ORDER BY priority, created_at, id LIMIT $2`,
        [status ?? null, limit]
      )
      return result.rows
    })
  }

  detail(
    actor: string,
    id: string
  ): Promise<
    | (CorrectionReportRow & {
        contact: { email?: string; phone?: string } | null
        evidence: string[] | null
      })
    | null
  > {
    return withAdminActor(this.db, actor, async (client) => {
      await requireDatabaseAdmin(client)
      const result = await client.query<
        CorrectionReportRow & {
          contact: { email?: string; phone?: string } | null
          evidence: string[] | null
        }
      >(
        `SELECT r.*, p.contact, p.evidence FROM public.correction_reports r
         LEFT JOIN private.correction_report_private p ON p.report_id=r.id WHERE r.id=$1`,
        [id]
      )
      return result.rows[0] ?? null
    })
  }

  claim(actor: string, id: string, version: number): Promise<CorrectionReportRow> {
    return withAdminActor(this.db, actor, async (client) => {
      await requireDatabaseAdmin(client)
      const result = await client.query<CorrectionReportRow>(
        "SELECT * FROM private.claim_correction_report($1,$2,$3)",
        [id, actor, version]
      )
      const row = result.rows[0]
      if (row === undefined) throw new Error("claim RPC returned no report")
      return row
    })
  }

  linkCorrection(
    actor: string,
    reportId: string,
    auditLogId: string,
    note: string
  ): Promise<ListingCorrectionRow | null> {
    return withAdminActor(this.db, actor, async (client) => {
      await requireDatabaseAdmin(client)
      const report = await client.query<{ event_id: string }>(
        "SELECT event_id FROM public.correction_reports WHERE id = $1 FOR UPDATE",
        [reportId]
      )
      const eventId = report.rows[0]?.event_id
      if (eventId === undefined) return null
      const result = await client.query<ListingCorrectionRow>(
        "SELECT * FROM private.link_listing_correction($1,$2,$3,$4,$5)",
        [reportId, eventId, actor, auditLogId, note]
      )
      return result.rows[0] ?? null
    })
  }

  resolve(
    actor: string,
    id: string,
    version: number,
    outcome: "resolved" | "dismissed",
    note: string,
    correctionId: string | null
  ): Promise<CorrectionReportRow> {
    return withAdminActor(this.db, actor, async (client) => {
      await requireDatabaseAdmin(client)
      const result = await client.query<CorrectionReportRow>(
        "SELECT * FROM private.resolve_correction_report($1,$2,$3,$4,$5,$6)",
        [id, actor, version, outcome, note, correctionId]
      )
      const row = result.rows[0]
      if (row === undefined) throw new Error("resolution RPC returned no report")
      return row
    })
  }

  restrict(actor: string, reporterId: string, reason: string, expiresAt: string): Promise<void> {
    return withAdminActor(this.db, actor, async (client) => {
      await requireDatabaseAdmin(client)
      await client.query(
        `INSERT INTO private.correction_reporter_restrictions
           (reporter_user_id,confirmed_by,reason,expires_at)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (reporter_user_id) DO UPDATE SET
           confirmed_by=EXCLUDED.confirmed_by,reason=EXCLUDED.reason,
           expires_at=EXCLUDED.expires_at,created_at=now()`,
        [reporterId, actor, reason, expiresAt]
      )
    })
  }
}
