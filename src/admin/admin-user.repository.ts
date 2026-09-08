import { Injectable } from "@nestjs/common"
import type { PoolClient } from "pg"

import { DbService } from "../db/db.service.js"
import { requireDatabaseAdmin, withAdminActor } from "./admin-database.js"
import type { AdminSetUserAccessInput } from "./admin-user.input.js"

export interface AdminUserAccessRow {
  user_id: string
  is_enabled: boolean
  access_expires_at: string | null
  enabled_at: string | null
  disabled_at: string | null
  disabled_reason: string | null
  display_name: string | null
  email: string | null
  role: "user" | "admin" | null
  profile_created_at: string | null
  created_at: string
  updated_at: string
}

const USER_ACCESS_COLUMNS = `
ua.user_id, ua.is_enabled, ua.access_expires_at, ua.enabled_at, ua.disabled_at,
ua.disabled_reason, up.display_name, up.email, up.role,
up.created_at AS profile_created_at, ua.created_at, ua.updated_at
`

const LIST_USERS_SQL = `
SELECT ${USER_ACCESS_COLUMNS}
FROM public.user_access ua
LEFT JOIN public.user_profiles up ON up.id = ua.user_id
ORDER BY ua.created_at DESC, ua.user_id
`

async function getUser(client: PoolClient, userId: string): Promise<AdminUserAccessRow | null> {
  const result = await client.query<AdminUserAccessRow>(
    `SELECT ${USER_ACCESS_COLUMNS}
     FROM public.user_access ua
     LEFT JOIN public.user_profiles up ON up.id = ua.user_id
     WHERE ua.user_id = $1::uuid`,
    [userId]
  )
  return result.rows[0] ?? null
}

@Injectable()
export class AdminUserRepository {
  constructor(private readonly db: DbService) {}

  list(actor: string): Promise<AdminUserAccessRow[]> {
    return withAdminActor(this.db, actor, async (client) => {
      await requireDatabaseAdmin(client)
      const result = await client.query<AdminUserAccessRow>(LIST_USERS_SQL)
      return result.rows
    })
  }

  setAccess(
    actor: string,
    userId: string,
    input: AdminSetUserAccessInput
  ): Promise<AdminUserAccessRow> {
    return withAdminActor(this.db, actor, async (client) => {
      await client.query("SELECT public.admin_set_user_access($1::uuid, $2::boolean, $3::text)", [
        userId,
        input.isEnabled,
        input.disabledReason,
      ])
      const user = await getUser(client, userId)
      if (user === null) throw new Error("updated admin user disappeared")
      return user
    })
  }

  delete(actor: string, userId: string): Promise<void> {
    return withAdminActor(this.db, actor, async (client) => {
      await client.query("SELECT public.admin_delete_user($1::uuid)", [userId])
    })
  }
}
