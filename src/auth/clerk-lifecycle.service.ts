import { randomUUID } from "node:crypto"

import { createClerkClient } from "@clerk/backend"
import { ConflictException, Injectable, ServiceUnavailableException } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"

import type { Env } from "../config/env.js"
import { DbService } from "../db/db.service.js"

@Injectable()
export class ClerkLifecycleService {
  constructor(
    private readonly db: DbService,
    private readonly config: ConfigService<Env, true>
  ) {}

  async apply(type: string, id: string): Promise<void> {
    if (type === "user.deleted") {
      await this.remove(id)
      return
    }
    if (
      (
        await this.db.query(
          "SELECT clerk_user_id FROM private.clerk_user_lifecycle WHERE clerk_user_id=$1 AND deleted_at IS NOT NULL",
          [id]
        )
      ).length
    )
      return
    if (type !== "user.created" && type !== "user.updated") return
    const secretKey = this.config.get("CLERK_SECRET_KEY", { infer: true })
    if (!secretKey) throw new ServiceUnavailableException("identity provider not configured")
    let user
    try {
      user = await createClerkClient({ secretKey }).users.getUser(id)
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        error.status === 404
      ) {
        await this.remove(id)
        return
      }
      throw new ServiceUnavailableException("identity provider unavailable")
    }
    if (user.id !== id) throw new ServiceUnavailableException("identity provider mismatch")
    const primary = user.emailAddresses.find((email) => email.id === user.primaryEmailAddressId)
    if (primary?.verification?.status !== "verified") return
    const email = primary.emailAddress.trim().toLowerCase()
    if (
      email.length < 3 ||
      email.length > 320 ||
      !email.includes("@") ||
      !Number.isSafeInteger(user.updatedAt) ||
      user.updatedAt < 0
    ) {
      throw new ServiceUnavailableException("invalid identity provider response")
    }
    await this.db.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`clerk:${id}`])
      if (
        (
          await client.query(
            "SELECT clerk_user_id FROM private.clerk_user_lifecycle WHERE clerk_user_id=$1 AND deleted_at IS NOT NULL",
            [id]
          )
        ).rows.length
      )
        return
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `clerk-email:${email}`,
      ])
      const mapped = await client.query<{ supabase_uuid: string }>(
        `SELECT m.supabase_uuid FROM public.clerk_user_mapping m
        JOIN auth.users au ON au.id=m.supabase_uuid WHERE m.clerk_user_id=$1 FOR UPDATE OF au`,
        [id]
      )
      const state = await client.query<{ provider_updated_at: string; deleted_at: string | null }>(
        "SELECT deleted_at,provider_updated_at FROM private.clerk_user_lifecycle WHERE clerk_user_id=$1",
        [id]
      )
      if (state.rows[0]?.deleted_at) return
      if (state.rows.length && Number(state.rows[0]!.provider_updated_at) >= user.updatedAt) return
      if (mapped.rows.length) {
        const uuid = mapped.rows[0]!.supabase_uuid
        const collision = await client.query(
          "SELECT id FROM auth.users WHERE lower(btrim(email))=$1 AND id<>$2",
          [email, uuid]
        )
        if (collision.rows.length)
          throw new ConflictException("email belongs to another historical account")
        await client.query(
          "UPDATE public.clerk_user_mapping SET email=$2,updated_at=now() WHERE clerk_user_id=$1",
          [id, email]
        )
        await client.query(
          "UPDATE public.user_profiles SET email=$2,updated_at=now() WHERE id=$1",
          [uuid, email]
        )
        await client.query(
          "UPDATE auth.users SET email=$2,email_confirmed_at=coalesce(email_confirmed_at,now()),updated_at=now() WHERE id=$1",
          [uuid, email]
        )
        await client.query(
          `INSERT INTO private.clerk_user_lifecycle(clerk_user_id,storage_uuid,provider_updated_at)
          VALUES($1,$2,$3) ON CONFLICT(clerk_user_id) DO UPDATE SET provider_updated_at=$3,updated_at=now()`,
          [id, uuid, user.updatedAt]
        )
        return
      }
      const historical = await client.query<{
        id: string
        role: string
        email_confirmed_at: string | null
      }>(
        `SELECT au.id,up.role,au.email_confirmed_at FROM auth.users au JOIN public.user_profiles up ON up.id=au.id
         WHERE lower(btrim(au.email))=$1 FOR UPDATE OF au`,
        [email]
      )
      if (historical.rows.length > 1 || historical.rows[0]?.email_confirmed_at === null)
        throw new ConflictException("historical account cannot be linked")
      let account = historical.rows[0]
      if (!account) {
        const uuid = randomUUID()
        await client.query(
          `INSERT INTO auth.users(id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
          VALUES($1,$2,now(),'{"provider":"clerk"}'::jsonb,$3::jsonb,now(),now())`,
          [
            uuid,
            email,
            JSON.stringify({
              display_name:
                [user.firstName, user.lastName].filter(Boolean).join(" ") || email.split("@")[0],
            }),
          ]
        )
        const claim = await client.query(
          `UPDATE public.pending_invite_claims SET claimed_by=$2,claimed_at=now()
          WHERE email=$1 AND claimed_by IS NULL AND expires_at>now() RETURNING email`,
          [email, uuid]
        )
        if (claim.rows.length) {
          await client.query(
            `UPDATE public.user_access SET is_enabled=true, enabled_at=coalesce(enabled_at,now()),
            disabled_at=NULL,disabled_reason=NULL,updated_at=now() WHERE user_id=$1`,
            [uuid]
          )
        }
        account = { id: uuid, role: "user", email_confirmed_at: "confirmed" }
      }
      const revoked = await client.query(
        "SELECT clerk_user_id FROM private.clerk_user_lifecycle WHERE storage_uuid=$1 AND deleted_at IS NOT NULL",
        [account.id]
      )
      if (revoked.rows.length) throw new ConflictException("historical account was deleted")
      const owned = await client.query(
        "SELECT clerk_user_id FROM public.clerk_user_mapping WHERE supabase_uuid=$1",
        [account.id]
      )
      if (owned.rows.length) throw new ConflictException("historical account already linked")
      await client.query(
        `INSERT INTO public.clerk_user_mapping(clerk_user_id,supabase_uuid,email,role) VALUES($1,$2,$3,$4)`,
        [id, account.id, email, account.role === "admin" ? "operator" : "member"]
      )
      await client.query(
        `INSERT INTO private.clerk_user_lifecycle(clerk_user_id,storage_uuid,provider_updated_at)
        VALUES($1,$2,$3) ON CONFLICT(clerk_user_id) DO UPDATE SET storage_uuid=$2,provider_updated_at=$3,updated_at=now()`,
        [id, account.id, user.updatedAt]
      )
    })
  }

  private async remove(id: string): Promise<void> {
    await this.db.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`clerk:${id}`])
      const mapped = await client.query<{ supabase_uuid: string }>(
        `SELECT m.supabase_uuid FROM public.clerk_user_mapping m
        JOIN auth.users au ON au.id=m.supabase_uuid WHERE m.clerk_user_id=$1 FOR UPDATE OF au`,
        [id]
      )
      const uuid = mapped.rows[0]?.supabase_uuid ?? null
      const state = await client.query(
        "SELECT deleted_at FROM private.clerk_user_lifecycle WHERE clerk_user_id=$1",
        [id]
      )
      if (state.rows[0]?.deleted_at) return
      await client.query(
        `INSERT INTO private.clerk_user_lifecycle(clerk_user_id,storage_uuid,deleted_at)
        VALUES($1,$2,now()) ON CONFLICT(clerk_user_id) DO UPDATE SET deleted_at=now(),updated_at=now()`,
        [id, uuid]
      )
      if (!uuid) return
      const profile = await client.query("SELECT * FROM public.user_profiles WHERE id=$1", [uuid])
      const access = await client.query("SELECT * FROM public.user_access WHERE user_id=$1", [uuid])
      let cleanupDeferred = false
      await client.query("SAVEPOINT clerk_account_cleanup")
      try {
        await client.query("DELETE FROM auth.users WHERE id=$1", [uuid])
        await client.query("RELEASE SAVEPOINT clerk_account_cleanup")
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT clerk_account_cleanup")
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "23503"
        )
          throw error
        cleanupDeferred = true
        await client.query("DELETE FROM public.clerk_user_mapping WHERE clerk_user_id=$1", [id])
        await client.query(
          `UPDATE public.user_access SET is_enabled=false,disabled_at=now(),
          disabled_reason='Clerk account deleted',updated_at=now() WHERE user_id=$1`,
          [uuid]
        )
      }
      await client.query(
        `INSERT INTO public.admin_audit_log(admin_user_id,action,target_type,target_id,metadata)
        VALUES(NULL,'user.delete','user_access',$1,$2::jsonb)`,
        [
          uuid,
          JSON.stringify({
            source: "clerk",
            cleanup_deferred: cleanupDeferred,
            previous_profile: profile.rows[0] ?? null,
            previous_access: access.rows[0] ?? null,
          }),
        ]
      )
    })
  }
}
