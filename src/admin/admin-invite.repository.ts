import { Injectable } from "@nestjs/common"

import { DbService } from "../db/db.service.js"
import { requireDatabaseAdmin, withAdminActor } from "./admin-database.js"
import type { AdminCreateInviteCodeInput } from "./admin-invite.input.js"

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
}
