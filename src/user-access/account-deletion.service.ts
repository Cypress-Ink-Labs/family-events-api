import type { AdminUserAccessRow } from "../admin/admin-user.repository.js"
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import type { PoolClient } from "pg"
import {
  isDatabaseAdminDenial,
  requireDatabaseAdmin,
  withAdminActor,
} from "../admin/admin-database.js"
import type { Env } from "../config/env.js"
import { DbService } from "../db/db.service.js"

function quoteSqlIdentifier(identifier: string) {
  return '"' + identifier.replaceAll('"', '""') + '"'
}

interface Deletion {
  user_id: string
  clerk_user_id: string | null
  status: string
  attempts: number
  provider_confirmed_at: string | null
  busy: boolean
}
@Injectable()
export class AccountDeletionService {
  constructor(
    private readonly db: DbService,
    private readonly config: ConfigService<Env, true>
  ) {}
  private async admin<T>(actor: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await withAdminActor(this.db, actor, async (client) => {
        await requireDatabaseAdmin(client)
        return work(client)
      })
    } catch (error) {
      if (isDatabaseAdminDenial(error))
        throw new ForbiddenException("admin access is not provisioned")
      if (error instanceof HttpException) throw error
      throw new ServiceUnavailableException(
        "Account deletion is unavailable. Check its status before retrying."
      )
    }
  }
  async list(actor: string) {
    return this.admin(
      actor,
      async (client) =>
        (
          await client.query(
            "SELECT user_id,status,attempts,requested_at,provider_confirmed_at,completed_at,last_error,updated_at FROM private.account_deletions ORDER BY requested_at DESC,user_id LIMIT 100"
          )
        ).rows
    )
  }
  async managed(actor: string, rows: AdminUserAccessRow[]) {
    return this.admin(actor, async (client) => {
      const revoked = await client.query<{ user_id: string }>(
        `SELECT user_id FROM private.account_deletions WHERE user_id=ANY($1::uuid[])
     UNION SELECT storage_uuid AS user_id FROM private.clerk_user_lifecycle WHERE storage_uuid=ANY($1::uuid[]) AND deleted_at IS NOT NULL`,
        [rows.map((row) => row.user_id)]
      )
      const deleted = new Set(revoked.rows.map((row) => row.user_id))
      return rows.map((row) => ({
        ...row,
        is_self: row.user_id === actor,
        can_disable: row.user_id !== actor && row.is_enabled && !deleted.has(row.user_id),
        can_enable: row.user_id !== actor && !row.is_enabled && !deleted.has(row.user_id),
        can_delete: row.user_id !== actor && row.role !== "admin" && !deleted.has(row.user_id),
      }))
    })
  }
  private protectedAccount(message: string): never {
    throw new BadRequestException({
      statusCode: 400,
      message: "invalid request body",
      error: "Bad Request",
      issues: [{ path: "id", message }],
    })
  }
  private async stage(actor: string, userId: string): Promise<Deletion> {
    return this.admin(actor, async (client) => {
      if (actor === userId) this.protectedAccount("cannot delete your own account")
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `account-delete:${userId}`,
      ])
      const existing = await client.query<Deletion>(
        "SELECT *,locked_until>now() AS busy FROM private.account_deletions WHERE user_id=$1 FOR UPDATE",
        [userId]
      )
      if (existing.rows[0]?.status === "completed") return existing.rows[0]
      if (existing.rows[0]?.busy)
        throw new ConflictException("Account deletion is already in progress")
      if (existing.rows[0]) {
        const claim = await client.query<Deletion>(
          "UPDATE private.account_deletions SET attempts=attempts+1,locked_until=now()+interval '30 seconds',updated_at=now() WHERE user_id=$1 RETURNING *",
          [userId]
        )
        return claim.rows[0]!
      }
      const linked = await client.query<{ clerk_user_id: string }>(
        "SELECT clerk_user_id FROM public.clerk_user_mapping WHERE supabase_uuid=$1",
        [userId]
      )
      const clerkId = linked.rows[0]?.clerk_user_id ?? null
      if (clerkId)
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `clerk:${clerkId}`,
        ])
      const auth = await client.query("SELECT id FROM auth.users WHERE id=$1 FOR UPDATE", [userId])
      if (!auth.rows.length) throw new NotFoundException()
      const latest = await client.query(
        "SELECT clerk_user_id FROM public.clerk_user_mapping WHERE supabase_uuid=$1",
        [userId]
      )
      if ((latest.rows[0]?.clerk_user_id ?? null) !== clerkId)
        throw new ConflictException("Identity link changed. Retry the deletion.")
      const profile = await client.query(
        "SELECT * FROM public.user_profiles WHERE id=$1 FOR UPDATE",
        [userId]
      )
      if (profile.rows[0]?.role === "admin")
        this.protectedAccount("cannot delete an administrator account")
      const access = await client.query(
        "SELECT * FROM public.user_access WHERE user_id=$1 FOR UPDATE",
        [userId]
      )
      const claimed = await client.query<Deletion>(
        `INSERT INTO private.account_deletions(user_id,clerk_user_id,status,attempts,locked_until,provider_confirmed_at)
    VALUES($1,$2,$3,1,now()+interval '30 seconds',CASE WHEN $2::text IS NULL THEN now() END) RETURNING *`,
        [userId, clerkId, clerkId ? "pending_provider" : "pending_cleanup"]
      )
      if (clerkId) {
        await client.query(
          `INSERT INTO private.clerk_user_lifecycle(clerk_user_id,storage_uuid,deleted_at) VALUES($1,$2,now())
     ON CONFLICT(clerk_user_id) DO UPDATE SET deleted_at=coalesce(private.clerk_user_lifecycle.deleted_at,now()),storage_uuid=$2,updated_at=now()`,
          [clerkId, userId]
        )
        await client.query("DELETE FROM public.clerk_user_mapping WHERE clerk_user_id=$1", [
          clerkId,
        ])
      }
      await client.query(
        "UPDATE public.user_access SET is_enabled=false,disabled_at=now(),disabled_reason='Account deletion requested',updated_at=now() WHERE user_id=$1",
        [userId]
      )
      await client.query(
        "UPDATE private.transactional_email_outbox SET status='cancelled',payload=NULL,delivery=NULL,locked_until=NULL,last_error='account_deleted',updated_at=now() WHERE kind='welcome' AND target_id=$1 AND status<>'sent'",
        [userId]
      )
      await client.query(
        "INSERT INTO public.admin_audit_log(admin_user_id,action,target_type,target_id,metadata) VALUES(auth.uid(),'user.delete_requested','user_access',$1,$2::jsonb)",
        [
          userId,
          JSON.stringify({
            previous_profile: profile.rows[0] ?? null,
            previous_access: access.rows[0] ?? null,
          }),
        ]
      )
      return claimed.rows[0]!
    })
  }
  private async deleteProvider(clerkId: string): Promise<void> {
    const secret = this.config.get("CLERK_SECRET_KEY", { infer: true })
    if (!secret) throw new Error("provider_not_configured")
    let response: Response
    try {
      response = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(clerkId)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" },
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      })
    } catch {
      throw new Error("provider_unavailable")
    }
    if (response.status === 404) return
    if (!response.ok) throw new Error(`provider_${response.status}`)
    const result: unknown = await response.json().catch(() => null)
    if (
      typeof result !== "object" ||
      result === null ||
      !("id" in result) ||
      result.id !== clerkId ||
      !("deleted" in result) ||
      result.deleted !== true
    )
      throw new Error("provider_invalid_response")
  }
  async delete(actor: string, userId: string): Promise<void> {
    const row = await this.stage(actor, userId)
    if (row.status === "completed") return
    if (!row.provider_confirmed_at && row.clerk_user_id) {
      try {
        await this.deleteProvider(row.clerk_user_id)
      } catch (error) {
        const reason =
          error instanceof Error &&
          /^(provider_not_configured|provider_unavailable|provider_invalid_response|provider_\d{3})$/.test(
            error.message
          )
            ? error.message
            : "provider_unavailable"
        await this.db.query(
          "UPDATE private.account_deletions SET last_error=$2,locked_until=NULL,updated_at=now() WHERE user_id=$1 AND attempts=$3",
          [userId, reason, row.attempts]
        )
        throw new ServiceUnavailableException(
          "Clerk deletion is pending. Account access remains revoked; retry this account deletion."
        )
      }
      const updated = await this.db.query(
        "UPDATE private.account_deletions SET status='pending_cleanup',provider_confirmed_at=now(),last_error=NULL,updated_at=now() WHERE user_id=$1 AND attempts=$2 RETURNING user_id",
        [userId, row.attempts]
      )
      if (!updated.length) throw new ConflictException("Account deletion is already in progress")
    }
    try {
      const deferred = await this.admin(actor, async (client) => {
        const state = await client.query<Deletion>(
          "SELECT * FROM private.account_deletions WHERE user_id=$1 FOR UPDATE",
          [userId]
        )
        if (state.rows[0]?.status === "completed") return false
        if (state.rows[0]?.attempts !== row.attempts)
          throw new ConflictException("Account deletion is already in progress")
        await client.query("SAVEPOINT account_cleanup")
        try {
          await client.query("SELECT public.admin_delete_user($1::uuid)", [userId])
          await client.query("RELEASE SAVEPOINT account_cleanup")
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT account_cleanup")
          if (
            typeof error !== "object" ||
            error === null ||
            !("code" in error) ||
            error.code !== "23503"
          )
            throw error
          const owned = await client.query<{
            schema: string
            table_name: string
            column_name: string
          }>(
            `SELECT DISTINCT ns.nspname AS schema,child.relname AS table_name,column_name.attname AS column_name
             FROM pg_constraint fk
             JOIN pg_class child ON child.oid=fk.conrelid
             JOIN pg_namespace ns ON ns.oid=child.relnamespace
             JOIN pg_attribute column_name ON column_name.attrelid=fk.conrelid AND column_name.attnum=fk.conkey[1]
             JOIN pg_attribute parent_column ON parent_column.attrelid=fk.confrelid AND parent_column.attnum=fk.confkey[1]
             WHERE fk.contype='f' AND fk.confdeltype='c' AND cardinality(fk.conkey)=1
               AND fk.confrelid IN ('auth.users'::regclass,'public.user_profiles'::regclass)
               AND parent_column.attname='id' AND ns.nspname IN ('public','private')
               AND fk.conrelid NOT IN ('public.user_profiles'::regclass,'public.user_access'::regclass)
             ORDER BY ns.nspname,child.relname,column_name.attname`
          )
          for (const table of owned.rows) {
            await client.query(
              `DELETE FROM ${quoteSqlIdentifier(table.schema)}.${quoteSqlIdentifier(table.table_name)} WHERE ${quoteSqlIdentifier(table.column_name)}=$1`,
              [userId]
            )
          }
          await client.query(
            "UPDATE public.user_profiles SET email=NULL,display_name=NULL,avatar_url=NULL,city_preference_id=NULL,child_name=NULL,child_age=NULL,updated_at=now() WHERE id=$1",
            [userId]
          )
          await client.query(
            "UPDATE auth.users SET email=NULL,email_confirmed_at=NULL,raw_app_meta_data='{}'::jsonb,raw_user_meta_data='{}'::jsonb,updated_at=now() WHERE id=$1",
            [userId]
          )
          if (state.rows[0]?.status !== "cleanup_deferred")
            await client.query(
              "INSERT INTO public.admin_audit_log(admin_user_id,action,target_type,target_id,metadata) VALUES(auth.uid(),'user.delete_cleanup_deferred','user_access',$1,'{\"cleanup_deferred\":true}'::jsonb)",
              [userId]
            )
          await client.query(
            "UPDATE private.account_deletions SET status='cleanup_deferred',locked_until=NULL,last_error='protected_attribution',updated_at=now() WHERE user_id=$1",
            [userId]
          )
          return true
        }
        await client.query(
          "UPDATE private.account_deletions SET status='completed',completed_at=now(),locked_until=NULL,last_error=NULL,updated_at=now() WHERE user_id=$1",
          [userId]
        )
        return false
      })
      if (deferred)
        throw new ConflictException(
          "Clerk account deleted and personal rows cleaned. Historical UUID remains protected by attribution."
        )
    } catch (error) {
      if (!(error instanceof ConflictException))
        await this.db.query(
          "UPDATE private.account_deletions SET last_error='cleanup_failed',locked_until=NULL,updated_at=now() WHERE user_id=$1 AND attempts=$2",
          [userId, row.attempts]
        )
      throw error
    }
  }
}
