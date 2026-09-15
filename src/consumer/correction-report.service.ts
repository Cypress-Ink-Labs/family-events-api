import { ConflictException, HttpException, HttpStatus, Injectable } from "@nestjs/common"
import type { PoolClient } from "pg"

import { DbService } from "../db/db.service.js"
import {
  capabilityHash,
  contentDigest,
  type CorrectionReportInput,
} from "./correction-report.input.js"

export interface SubmittedCorrectionReport {
  id: string
  status: "new"
  priority: number
  created_at: string
}

@Injectable()
export class CorrectionReportService {
  constructor(private readonly db: DbService) {}

  async mintAnonymousCapability(capability: string): Promise<void> {
    await this.db.withTransaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('correction-report-capability-issuance', 0))"
      )
      await client.query(
        `DELETE FROM private.correction_report_capabilities
         WHERE expires_at <= now() OR consumed_at < now() - interval '1 hour'`
      )
      const issued = await client.query(
        `SELECT count(*)::int AS count FROM private.correction_report_capabilities
         WHERE created_at > now() - interval '1 minute'`
      )
      if ((issued.rows[0]?.count ?? 0) >= 120)
        throw new HttpException("capability limit reached", HttpStatus.TOO_MANY_REQUESTS)
      await client.query(
        `INSERT INTO private.correction_report_capabilities(token_hash, expires_at)
         VALUES ($1, now() + interval '15 minutes')`,
        [capabilityHash(capability)]
      )
    })
  }

  submit(
    eventId: string,
    input: CorrectionReportInput,
    reporterUserId: string | null,
    presentedCapability: string | undefined,
    replacementCapability: string
  ): Promise<SubmittedCorrectionReport> {
    return this.db.withTransaction(async (client) => {
      await this.assertEventExists(client, eventId)
      if (reporterUserId === null) {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('correction-report-anonymous:' || $1, 0))",
          [eventId]
        )
        await this.consumeAnonymousCapability(client, presentedCapability)
        const recent = await client.query(
          `SELECT count(*)::int AS count FROM public.correction_reports
           WHERE reporter_user_id IS NULL AND event_id = $1
             AND created_at > now() - interval '15 minutes'`,
          [eventId]
        )
        if ((recent.rows[0]?.count ?? 0) >= 20) {
          throw new HttpException("report limit reached", HttpStatus.TOO_MANY_REQUESTS)
        }
        await client.query(
          `DELETE FROM private.correction_report_capabilities
           WHERE expires_at <= now() OR consumed_at < now() - interval '1 hour'`
        )
        await client.query(
          `INSERT INTO private.correction_report_capabilities(token_hash, expires_at)
           VALUES ($1, now() + interval '15 minutes')`,
          [capabilityHash(replacementCapability)]
        )
      } else {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('correction-report-user:' || $1, 0))",
          [reporterUserId]
        )
        const restricted = await client.query(
          `SELECT 1 FROM private.correction_reporter_restrictions
           WHERE reporter_user_id = $1 AND expires_at > now()`,
          [reporterUserId]
        )
        if (restricted.rowCount !== 0)
          throw new HttpException("reporting unavailable", HttpStatus.TOO_MANY_REQUESTS)
        const recent = await client.query(
          `SELECT count(*)::int AS count FROM public.correction_reports
           WHERE reporter_user_id = $1 AND created_at > now() - interval '15 minutes'`,
          [reporterUserId]
        )
        if ((recent.rows[0]?.count ?? 0) >= 5)
          throw new HttpException("report limit reached", HttpStatus.TOO_MANY_REQUESTS)
      }

      await client.query(
        "DELETE FROM private.correction_report_recent_content WHERE expires_at <= now()"
      )
      const digest = contentDigest(eventId, input)
      const duplicate = await client.query(
        `INSERT INTO private.correction_report_recent_content(digest, event_id, expires_at)
         VALUES ($1, $2, now() + interval '15 minutes')
         ON CONFLICT (digest) DO UPDATE
           SET event_id = EXCLUDED.event_id, expires_at = EXCLUDED.expires_at,
               submission_count = 1
           WHERE private.correction_report_recent_content.expires_at <= now()
         RETURNING digest`,
        [digest, eventId]
      )
      if (duplicate.rowCount === 0) throw new ConflictException("report already received")

      const result = await client.query<SubmittedCorrectionReport>(
        `INSERT INTO public.correction_reports(event_id, reporter_user_id, category, details)
         VALUES ($1, $2, $3, $4) RETURNING id, status, priority, created_at`,
        [eventId, reporterUserId, input.category, input.details]
      )
      const report = result.rows[0]
      if (report === undefined) throw new Error("correction report insert failed")
      if (input.contact !== undefined || input.evidence_urls !== undefined) {
        await client.query(
          `INSERT INTO private.correction_report_private(report_id, contact, evidence)
           VALUES ($1, $2, $3)`,
          [
            report.id,
            input.contact === undefined ? null : JSON.stringify(input.contact),
            input.evidence_urls ?? null,
          ]
        )
      }
      return report
    })
  }

  private async assertEventExists(client: PoolClient, eventId: string): Promise<void> {
    const result = await client.query("SELECT 1 FROM public.events WHERE id = $1", [eventId])
    if (result.rowCount === 0) throw new ConflictException("report cannot be accepted")
  }

  private async consumeAnonymousCapability(
    client: PoolClient,
    capability: string | undefined
  ): Promise<void> {
    if (capability === undefined)
      throw new HttpException("report capability required", HttpStatus.TOO_MANY_REQUESTS)
    const result = await client.query(
      `UPDATE private.correction_report_capabilities SET consumed_at = now()
       WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
       RETURNING token_hash`,
      [capabilityHash(capability)]
    )
    if (result.rowCount === 0)
      throw new HttpException("report capability expired", HttpStatus.TOO_MANY_REQUESTS)
  }
}
