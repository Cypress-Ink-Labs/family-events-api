import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common"
import type { PoolClient } from "pg"
import { DbService } from "../db/db.service.js"
import { FAMILIES, JOB_FAMILIES } from "../pipeline/families.js"
import { isDatabaseAdminDenial, requireDatabaseAdmin, withAdminActor } from "./admin-database.js"
import type {
  AdminAiModelDto,
  AdminAiFeatureDto,
  AdminAiUpdateDto,
  AdminPresenceDto,
  AdminIngestionDayDto,
  AdminRecentRunDto,
} from "./admin-ai.dto.js"

@Injectable()
export class AdminAiRepository {
  constructor(private readonly db: DbService) {}
  private async asAdmin<T>(actor: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await withAdminActor(this.db, actor, async (client) => {
        await requireDatabaseAdmin(client)
        return work(client)
      })
    } catch (error) {
      if (isDatabaseAdminDenial(error))
        throw new ForbiddenException("admin access is not provisioned")
      throw error
    }
  }
  settings(actor: string) {
    return this.asAdmin(actor, async (client) => ({
      models: (
        await client.query<AdminAiModelDto>(
          "SELECT id,provider,display_name,description,cost_tier FROM public.approved_ai_models WHERE is_enabled=true ORDER BY cost_tier,display_name,id"
        )
      ).rows,
      features: (
        await client.query<AdminAiFeatureDto>(
          "SELECT feature,model_id,enabled,updated_at,updated_by FROM public.ai_feature_config ORDER BY feature"
        )
      ).rows,
    }))
  }
  update(actor: string, feature: string, input: AdminAiUpdateDto) {
    return this.asAdmin(actor, async (client) => {
      const model = await client.query(
        "SELECT id FROM public.approved_ai_models WHERE id=$1 AND is_enabled=true FOR SHARE",
        [input.model_id]
      )
      if (!model.rowCount) throw new BadRequestException("model is not approved or enabled")
      const before =
        (
          await client.query(
            "SELECT feature,model_id,enabled,updated_at,updated_by FROM public.ai_feature_config WHERE feature=$1 FOR UPDATE",
            [feature]
          )
        ).rows[0] ?? null
      await client.query("SELECT public.upsert_ai_feature_config($1,$2,$3)", [
        feature,
        input.model_id,
        input.enabled,
      ])
      const after = (
        await client.query<AdminAiFeatureDto>(
          "SELECT feature,model_id,enabled,updated_at,updated_by FROM public.ai_feature_config WHERE feature=$1",
          [feature]
        )
      ).rows[0]!
      await client.query(
        "INSERT INTO public.admin_audit_log(admin_user_id,action,target_type,metadata) VALUES($1::uuid,'update_ai_feature','ai_feature',$2::jsonb)",
        [actor, JSON.stringify({ feature, before, after })]
      )
      return after
    })
  }
  health(actor: string) {
    return this.asAdmin(actor, async (client) => {
      await client.query(
        "INSERT INTO private.operator_presence(user_id,last_seen_at) VALUES($1::uuid,now()) ON CONFLICT(user_id) DO UPDATE SET last_seen_at=excluded.last_seen_at",
        [actor]
      )
      await client.query(
        "DELETE FROM private.operator_presence WHERE last_seen_at<now()-interval '90 seconds'"
      )
      const presence = (
        await client.query<AdminPresenceDto>(
          "SELECT p.user_id,COALESCE(NULLIF(up.display_name,''),'Admin') AS display_name FROM private.operator_presence p JOIN public.user_profiles up ON up.id=p.user_id JOIN public.user_access ua ON ua.user_id=p.user_id JOIN public.clerk_user_mapping m ON m.supabase_uuid=p.user_id WHERE p.last_seen_at>=now()-interval '90 seconds' AND up.role='admin' AND m.role='operator' AND ua.is_enabled AND (ua.access_expires_at IS NULL OR ua.access_expires_at>now()) ORDER BY display_name,p.user_id"
        )
      ).rows
      const ingestion = (
        await client.query<AdminIngestionDayDto>(
          "SELECT to_char(day,'YYYY-MM-DD') AS day,COALESCE(sum(r.events_imported),0)::int AS imported,COALESCE(sum(r.events_skipped),0)::int AS skipped,count(*) FILTER (WHERE r.status='error')::int AS errors FROM generate_series((now() AT TIME ZONE 'UTC')::date-6,(now() AT TIME ZONE 'UTC')::date,interval '1 day') day LEFT JOIN public.source_runs r ON (r.started_at AT TIME ZONE 'UTC')::date=day::date GROUP BY day ORDER BY day"
        )
      ).rows
      const recent_runs = (
        await client.query<AdminRecentRunDto>(
          "SELECT r.id,s.name AS source_name,r.started_at,r.status,r.events_imported,r.events_skipped FROM public.source_runs r LEFT JOIN public.event_sources s ON s.id=r.source_id ORDER BY r.started_at DESC,r.id DESC LIMIT 4"
        )
      ).rows
      const gates = (
        await client.query<{ label: string; enabled: boolean }>(
          "SELECT label,enabled FROM private.cron_enabled"
        )
      ).rows
      const enabled = new Map(gates.map((row) => [row.label, row.enabled]))
      const schedules = JOB_FAMILIES.flatMap((family) =>
        FAMILIES[family].schedules.map((schedule) => {
          const legacy =
            schedule.replaces === null ? null : (enabled.get(schedule.replaces) ?? true)
          const nest =
            schedule.replaces === null ? null : (enabled.get(`nestjs:${schedule.replaces}`) ?? true)
          return {
            family,
            task: schedule.task,
            replaces: schedule.replaces,
            legacy_enabled: legacy,
            nest_enabled: nest,
            owner: legacy === null ? "internal" : legacy ? "legacy" : nest ? "api" : "paused",
          }
        })
      )
      return { generated_at: new Date().toISOString(), presence, ingestion, recent_runs, schedules }
    })
  }
}
