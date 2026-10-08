import { createHash } from "node:crypto"
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from "@nestjs/common"
import { IdentityService } from "../auth/identity.service.js"
import { DbService } from "../db/db.service.js"

@Injectable()
export class OnboardingService {
  constructor(
    private readonly db: DbService,
    private readonly identity: IdentityService
  ) {}
  async redeem(id: string, code: string) {
    const outcome = await this.db.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`clerk:${id}`])
      const mapped = await client.query<{ supabase_uuid: string; email: string; role: string }>(
        "SELECT supabase_uuid,email,role FROM public.clerk_user_mapping WHERE clerk_user_id=$1",
        [id]
      )
      const actor = mapped.rows[0]
      if (!actor) {
        const deleted = await client.query(
          "SELECT clerk_user_id FROM private.clerk_user_lifecycle WHERE clerk_user_id=$1 AND deleted_at IS NOT NULL",
          [id]
        )
        return deleted.rows.length ? "denied" : "pending"
      }
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `clerk-email:${actor.email}`,
      ])
      const access = await client.query<{ allowed: boolean; eligible: boolean }>(
        `SELECT
    ua.is_enabled AND (ua.access_expires_at IS NULL OR ua.access_expires_at>now()) AS allowed,
    NOT ua.is_enabled AND ua.enabled_at IS NULL AND ua.disabled_at IS NULL AND ua.disabled_reason IS NULL
    AND ua.access_expires_at IS NULL AS eligible
    FROM auth.users au JOIN public.user_access ua ON ua.user_id=au.id
    JOIN public.clerk_user_mapping m ON m.supabase_uuid=au.id AND m.clerk_user_id=$1
    WHERE au.id=$2 FOR UPDATE OF au,ua`,
        [id, actor.supabase_uuid]
      )
      if (access.rows[0]?.allowed) return "ready"
      if (!access.rows[0]?.eligible || actor.role !== "member") return "denied"
      const claimed = await client.query(
        "SELECT email FROM public.pending_invite_claims WHERE email=$1 AND claimed_by IS NOT NULL",
        [actor.email]
      )
      if (claimed.rows.length) return "denied"
      const redeemed = await client.query<{ ok: boolean }>(
        "SELECT public.redeem_invite_for_email($1,$2) AS ok",
        [code, actor.email]
      )
      if (redeemed.rows[0]?.ok !== true) return "invalid"
      const claim = await client.query(
        `UPDATE public.pending_invite_claims SET claimed_by=$2,claimed_at=now()
    WHERE email=$1 AND claimed_by IS NULL AND expires_at>now() RETURNING email`,
        [actor.email, actor.supabase_uuid]
      )
      if (!claim.rows.length)
        throw new ConflictException("Invitation could not be claimed. Try again.")
      await client.query(
        `UPDATE public.user_access SET is_enabled=true,enabled_at=now(),updated_at=now()
    WHERE user_id=$1`,
        [actor.supabase_uuid]
      )
      await client.query(
        `INSERT INTO public.admin_audit_log(admin_user_id,action,target_type,target_id,metadata)
    VALUES($1,'user.invite_redeem','user',$1,'{"source":"clerk"}'::jsonb)`,
        [actor.supabase_uuid]
      )
      return "ready"
    })
    if (outcome === "pending")
      throw new ConflictException("Your account is still being provisioned. Retry shortly.")
    if (outcome === "denied")
      throw new ForbiddenException("Account access is unavailable. Contact the administrator.")
    if (outcome === "invalid")
      throw new BadRequestException(
        "Invitation is invalid, expired, exhausted, revoked, or temporarily rate limited."
      )
    return { state: "ready", ...(await this.policy()) }
  }
  async request(email: string, message: string | null) {
    const emailHash = createHash("sha256").update(email).digest("hex")
    await this.db.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `invite-request:${email}`,
      ])
      const limited = await client.query<{ limited: boolean }>(
        "SELECT private.is_invite_request_rate_limited($1) AS limited",
        [emailHash]
      )
      if (limited.rows[0]?.limited) return
      await client.query(
        `INSERT INTO public.invite_requests(email,message) VALUES($1,$2)
     ON CONFLICT(lower(email)) WHERE status='pending' DO UPDATE SET message=coalesce(EXCLUDED.message,invite_requests.message)`,
        [email, message]
      )
      await client.query(
        "INSERT INTO public.invite_request_attempts(email_hash,succeeded) VALUES($1,true)",
        [emailHash]
      )
    })
    return { received: true }
  }
  async status(id: string) {
    const policy = await this.policy()
    const identity = await this.identity.resolve(id)
    if (!identity) {
      const deleted = await this.db.query(
        "SELECT clerk_user_id FROM private.clerk_user_lifecycle WHERE clerk_user_id=$1 AND deleted_at IS NOT NULL",
        [id]
      )
      return { state: deleted.length ? "access_unavailable" : "provisioning_pending", ...policy }
    }
    const rows = await this.db.query<{ allowed: boolean; eligible: boolean }>(
      `SELECT
   is_enabled AND (access_expires_at IS NULL OR access_expires_at>now()) AS allowed,
   NOT is_enabled AND enabled_at IS NULL AND disabled_at IS NULL AND disabled_reason IS NULL
   AND access_expires_at IS NULL AS eligible FROM public.user_access WHERE user_id=$1`,
      [identity.supabaseUuid]
    )
    return {
      state: rows[0]?.allowed
        ? "ready"
        : rows[0]?.eligible && identity.role === "member" && policy.required
          ? "invite_required"
          : "access_unavailable",
      ...policy,
    }
  }
  async policy() {
    const rows = await this.db.query<{ required: boolean }>(
      "SELECT private.invites_required() AS required"
    )
    return { required: rows[0]?.required !== false }
  }
}
