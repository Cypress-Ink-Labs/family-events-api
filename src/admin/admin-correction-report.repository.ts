import { ForbiddenException, Injectable } from "@nestjs/common"

import type { PoolClient } from "pg"

import { DbService } from "../db/db.service.js"
import { isDatabaseAdminDenial, requireDatabaseAdmin, withAdminActor } from "./admin-database.js"

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
> & { event_title: string }

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

  private async withActor<T>(actor: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await withAdminActor(this.db, actor, work)
    } catch (error) {
      if (isDatabaseAdminDenial(error))
        throw new ForbiddenException("admin access is not provisioned")
      throw error
    }
  }

  list(
    actor: string,
    status: string | undefined,
    limit: number
  ): Promise<CorrectionReportListRow[]> {
    return this.withActor(actor, async (client) => {
      await requireDatabaseAdmin(client)
      const result = await client.query<CorrectionReportListRow>(
        `SELECT r.id,r.event_id,e.title AS event_title,r.category,r.priority,r.status,r.version,
                r.claimed_by,r.claimed_at,r.resolved_by,r.resolved_at,r.correction_id,
                r.created_at,r.updated_at
         FROM public.correction_reports r JOIN public.events e ON e.id=r.event_id
         WHERE ($1::correction_report_status IS NULL OR r.status = $1)
         ORDER BY r.priority, r.created_at, r.id LIMIT $2`,
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
        event_title: string
        contact: { email?: string; phone?: string } | null
        evidence: string[] | null
      })
    | null
  > {
    return this.withActor(actor, async (client) => {
      await requireDatabaseAdmin(client)
      const result = await client.query<
        CorrectionReportRow & {
          event_title: string
          contact: { email?: string; phone?: string } | null
          evidence: string[] | null
        }
      >(
        `SELECT r.*, e.title AS event_title, p.contact, p.evidence FROM public.correction_reports r
         JOIN public.events e ON e.id=r.event_id
         LEFT JOIN private.correction_report_private p ON p.report_id=r.id WHERE r.id=$1`,
        [id]
      )
      return result.rows[0] ?? null
    })
  }

  claim(actor: string, id: string, version: number): Promise<CorrectionReportRow> {
    return this.withActor(actor, async (client) => {
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
    return this.withActor(actor, async (client) => {
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
    return this.withActor(actor, async (client) => {
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
    return this.withActor(actor, async (client) => {
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
