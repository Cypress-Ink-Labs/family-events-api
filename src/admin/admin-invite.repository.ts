import { Injectable } from "@nestjs/common"

import { DbService } from "../db/db.service.js"
import { requireDatabaseAdmin, withAdminActor } from "./admin-database.js"
import type {
  AdminCreateInviteCodeInput,
  AdminInviteRequestStatus,
  AdminRejectInviteRequestInput,
} from "./admin-invite.input.js"

export interface AdminInviteCodeRow {
  id: string
  max_uses: string | number
  used_count: string | number
  expires_at: string | null
  revoked_at: string | null
  notes: string | null
  created_by: string | null
  created_at: string
}
export interface AdminCreatedInviteCodeRow {
  id: string
  code: string
  max_uses: string | number
  expires_at: string | null
  notes: string | null
  created_at: string
}
export interface AdminInviteRequestRow {
  id: string
  email: string
  message: string | null
  status: "pending" | "approved" | "rejected"
  invite_code_id: string | null
  admin_notes: string | null
  created_at: string
  reviewed_at: string | null
  reviewed_by: string | null
}
export interface AdminApprovedInviteRequestRow {
  request_id: string
  code: string
  invite_code_id: string
  email: string
  created_at: string
}

@Injectable()
export class AdminInviteRepository {
  constructor(private readonly db: DbService) {}

  required(actor: string): Promise<boolean> {
    return withAdminActor(this.db, actor, async (client) => {
      await requireDatabaseAdmin(client)
      const result = await client.query<{ required: boolean }>(
        "SELECT public.invites_required() AS required"
      )
      return result.rows[0]?.required === true
    })
  }

  listCodes(actor: string): Promise<AdminInviteCodeRow[]> {
    return withAdminActor(this.db, actor, async (client) => {
      await requireDatabaseAdmin(client)
      const result = await client.query<AdminInviteCodeRow>(
        `SELECT id, max_uses, used_count, expires_at, revoked_at, notes, created_by, created_at
         FROM public.invite_codes ORDER BY created_at DESC, id`
      )
      return result.rows
    })
  }

  createCode(actor: string, input: AdminCreateInviteCodeInput): Promise<AdminCreatedInviteCodeRow> {
    return withAdminActor(this.db, actor, async (client) => {
      const result = await client.query<AdminCreatedInviteCodeRow>(
        `SELECT id, code, max_uses, expires_at, notes, created_at
         FROM public.admin_create_invite_code($1::integer, $2::timestamptz, $3::text)`,
        [input.maxUses, input.expiresAt ?? null, input.notes ?? null]
      )
      const row = result.rows[0]
      if (row === undefined) throw new Error("invite code creation returned no row")
      await client.query(
        `INSERT INTO public.admin_audit_log
           (admin_user_id, action, target_type, target_id, metadata)
         VALUES (auth.uid(), 'invite_code.create', 'invite_code', $1::uuid, $2::jsonb)`,
        [
          row.id,
          JSON.stringify({
            max_uses: input.maxUses,
            expires_at: input.expiresAt ?? null,
            notes: input.notes ?? null,
          }),
        ]
      )
      return row
    })
  }

  revokeCode(actor: string, id: string): Promise<boolean> {
    return withAdminActor(this.db, actor, async (client) => {
      const result = await client.query<{ ok: boolean }>(
        "SELECT public.admin_revoke_invite_code($1::uuid) AS ok",
        [id]
      )
      const ok = result.rows[0]?.ok === true
      if (ok) {
        await client.query(
          `INSERT INTO public.admin_audit_log
             (admin_user_id, action, target_type, target_id, metadata)
           VALUES (auth.uid(), 'invite_code.revoke', 'invite_code', $1::uuid, '{}'::jsonb)`,
          [id]
        )
      }
      return ok
    })
  }

  listRequests(actor: string, status: AdminInviteRequestStatus): Promise<AdminInviteRequestRow[]> {
    return withAdminActor(this.db, actor, async (client) => {
      await requireDatabaseAdmin(client)
      const result = await client.query<AdminInviteRequestRow>(
        `SELECT id, email, message, status, invite_code_id, admin_notes,
                created_at, reviewed_at, reviewed_by
         FROM public.invite_requests
         WHERE ($1::text = 'all' OR status::text = $1::text)
         ORDER BY created_at DESC, id`,
        [status]
      )
      return result.rows
    })
  }

  approveRequest(actor: string, id: string): Promise<AdminApprovedInviteRequestRow> {
    return withAdminActor(this.db, actor, async (client) => {
      const result = await client.query<AdminApprovedInviteRequestRow>(
        `SELECT request_id, code, invite_code_id, email, created_at
         FROM public.admin_approve_invite_request($1::uuid)`,
        [id]
      )
      const row = result.rows[0]
      if (row === undefined) throw new Error("invite request approval returned no row")
      await client.query(
        `INSERT INTO public.admin_audit_log
           (admin_user_id, action, target_type, target_id, metadata)
         VALUES (auth.uid(), 'invite_request.approve', 'invite_request', $1::uuid, $2::jsonb)`,
        [id, JSON.stringify({ invite_code_id: row.invite_code_id, email: row.email })]
      )
      return row
    })
  }

  rejectRequest(actor: string, id: string, input: AdminRejectInviteRequestInput): Promise<boolean> {
    return withAdminActor(this.db, actor, async (client) => {
      const notes = input.notes?.trim() || null
      const result = await client.query<{ ok: boolean }>(
        "SELECT public.admin_reject_invite_request($1::uuid, $2::text) AS ok",
        [id, notes]
      )
      const ok = result.rows[0]?.ok === true
      if (ok) {
        await client.query(
          `INSERT INTO public.admin_audit_log
             (admin_user_id, action, target_type, target_id, metadata)
           VALUES (auth.uid(), 'invite_request.reject', 'invite_request', $1::uuid, $2::jsonb)`,
          [id, JSON.stringify({ notes })]
        )
      }
      return ok
    })
  }
}
