import { BadRequestException, ConflictException, Injectable } from "@nestjs/common"
import type { PoolClient } from "pg"
import { ConfigService } from "@nestjs/config"
import { DbService } from "../db/db.service.js"
import { requireDatabaseAdmin, withAdminActor } from "./admin-database.js"
import type { scheduledOperations } from "../pipeline/scheduled-operations.js"

type Operation = ReturnType<typeof scheduledOperations>[number]
export type CronOwner = "api" | "legacy" | "paused"

@Injectable()
export class AdminCronControlsRepository {
  constructor(
    private readonly db: DbService,
    private readonly config: ConfigService
  ) {}

  private authorized<T>(
    actor: string,
    operation: Operation,
    work: (client: PoolClient) => Promise<T>
  ) {
    return withAdminActor(this.db, actor, async (client) => {
      await requireDatabaseAdmin(client)
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `cron-control:${operation.label}`,
      ])
      return work(client)
    })
  }

  setOwner(actor: string, operation: Operation, owner: CronOwner, installed: boolean) {
    return this.authorized(actor, operation, async (client) => {
      if (owner === "api" && !installed)
        throw new ConflictException("API family is disabled by its cutover flag")
      if (owner === "legacy" && operation.replaces === null)
        throw new BadRequestException("Internal schedules have no legacy owner")
      if (owner === "legacy") {
        const schema = this.config.get<string>("PGBOSS_SCHEMA") ?? "pgboss"
        const table = `"${schema.replaceAll('"', '""')}"."job"`
        const exists = await client.query<{ table: string | null }>(
          "SELECT to_regclass($1)::text AS table",
          [table]
        )
        if (exists.rows[0]?.table) {
          await client.query(`LOCK TABLE ${table} IN SHARE MODE`)
          const active = await client.query(
            `SELECT 1 FROM ${table} WHERE name=$1 AND state='active' LIMIT 1`,
            [operation.queue]
          )
          if (active.rows.length)
            throw new ConflictException(
              "Wait for active API jobs to finish before returning ownership to legacy"
            )
        }
      }
      const previous = (
        await client.query(
          "SELECT label,enabled FROM private.cron_enabled WHERE label=ANY($1::text[])",
          [[operation.label, operation.gateLabel]]
        )
      ).rows
      if (operation.replaces !== null) {
        await client.query(
          "INSERT INTO private.cron_enabled(label,enabled) VALUES($1,$2) ON CONFLICT(label) DO UPDATE SET enabled=EXCLUDED.enabled,updated_at=now()",
          [operation.replaces, owner === "legacy"]
        )
      }
      await client.query(
        "INSERT INTO private.cron_enabled(label,enabled) VALUES($1,$2) ON CONFLICT(label) DO UPDATE SET enabled=EXCLUDED.enabled,updated_at=now()",
        [operation.gateLabel, owner === "api"]
      )
      await this.audit(client, actor, "cron.owner", { label: operation.label, owner, previous })
      return { label: operation.label, owner }
    })
  }

  dispatch(
    actor: string,
    operation: Operation,
    installed: boolean,
    send: (client: PoolClient) => Promise<string | null>
  ) {
    return this.authorized(actor, operation, async (client) => {
      if (!installed) throw new ConflictException("API family is disabled by its cutover flag")
      const rows = (
        await client.query<{ label: string; enabled: boolean }>(
          "SELECT label,enabled FROM private.cron_enabled WHERE label=ANY($1::text[])",
          [[operation.label, operation.gateLabel]]
        )
      ).rows
      const gates = new Map(rows.map((row) => [row.label, row.enabled]))
      if (operation.replaces !== null && (gates.get(operation.replaces) ?? true))
        throw new ConflictException("The legacy pipeline owns this schedule")
      if (!(gates.get(operation.gateLabel) ?? true))
        throw new ConflictException("API schedule is paused")
      const jobId = await send(client)
      await this.audit(client, actor, "cron.run", {
        label: operation.label,
        job_id: jobId,
        accepted: jobId !== null,
      })
      return { label: operation.label, accepted: jobId !== null, job_id: jobId }
    })
  }

  private async audit(client: PoolClient, actor: string, action: string, metadata: object) {
    await client.query(
      "INSERT INTO public.admin_audit_log(admin_user_id,action,target_type,target_id,metadata) VALUES($1,$2,'cron',NULL,$3::jsonb)",
      [actor, action, JSON.stringify(metadata)]
    )
  }
}
