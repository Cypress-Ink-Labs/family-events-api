import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common"
import { z } from "zod"

import { isFamilyEnabled } from "../pipeline/flags.js"
import { scheduledOperations } from "../pipeline/scheduled-operations.js"
import { isDatabaseAdminDenial } from "./admin-database.js"
import { CRON_LABELS } from "./admin-cron.input.js"
import { AdminCronRepository } from "./admin-cron.repository.js"

const decimalId = z
  .string()
  .regex(/^[1-9]\d*$/)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n)
const summarySchema = z.strictObject({
  id: decimalId,
  label: z.string().refine((value) => CRON_LABELS.includes(value)),
  status: z.string(),
  ran_at: z.string(),
  duration_s: z.number().int().nullable(),
  http_status: z.number().int().nullable(),
})
const gateRowSchema = z.strictObject({
  label: z.string().refine((value) => CRON_LABELS.includes(value)),
  legacy_enabled: z.boolean(),
  nest_enabled: z.boolean(),
  id: decimalId.nullable(),
  status: z.string().nullable(),
  ran_at: z.string().nullable(),
  duration_s: z.number().int().nullable(),
  http_status: z.number().int().nullable(),
})
const logSchema = z.strictObject({
  id: decimalId,
  provider: z.enum(["railway", "supabase"]),
  level: z.enum(["debug", "info", "log", "warn", "error"]),
  message: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  sequence: z.number().int().nullable(),
  created_at: z.string(),
})
const detailSchema = summarySchema.extend({
  run_key: z.uuid(),
  body: z.string().nullable(),
  logs: z.array(logSchema),
})

@Injectable()
export class AdminCronService {
  constructor(private readonly repository: AdminCronRepository) {}
  private async safe<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      if (isDatabaseAdminDenial(error))
        throw new ForbiddenException("admin access is not provisioned")
      throw error
    }
  }
  async schedules(actor: string) {
    const rows = z
      .array(gateRowSchema)
      .parse(await this.safe(() => this.repository.gatesAndLatest(actor, CRON_LABELS)))
    const byLabel = new Map(rows.map((row) => [row.label, row]))
    return {
      items: scheduledOperations().map((operation) => {
        const row = byLabel.get(operation.label)
        const legacy = operation.replaces === null ? null : (row?.legacy_enabled ?? true)
        const nest = row?.nest_enabled ?? true
        const cutover = isFamilyEnabled(operation.family, process.env)
        return {
          family: operation.family,
          queue: operation.queue,
          task: operation.task,
          key: operation.key,
          label: operation.label,
          cron: operation.cron,
          timezone: "UTC" as const,
          replaces: operation.replaces,
          legacy_enabled: legacy,
          nest_enabled: operation.replaces === null ? null : nest,
          cutover_enabled: cutover,
          effective_enabled: cutover && legacy !== true && nest,
          owner:
            legacy === true
              ? ("legacy" as const)
              : !nest
                ? ("paused" as const)
                : legacy === null
                  ? ("internal" as const)
                  : ("api" as const),
          latest_run: row?.id
            ? {
                id: row.id,
                label: operation.label,
                status: row.status,
                ran_at: row.ran_at,
                duration_s: row.duration_s,
                http_status: row.http_status,
              }
            : null,
        }
      }),
    }
  }
  async runs(actor: string, label: string | undefined, limit: number) {
    const rows = await this.safe(() => this.repository.runs(actor, CRON_LABELS, label, limit))
    return { items: z.array(summarySchema).parse(rows) }
  }
  async detail(actor: string, id: string) {
    const result = await this.safe(() => this.repository.detail(actor, id))
    if (!result) throw new NotFoundException("cron run not found")
    return detailSchema.parse(result)
  }
}
