import { Injectable } from "@nestjs/common"

import { DbService } from "../db/db.service.js"

export type MappedRole = "operator" | "member"

// Retained UUIDs preserve ownership while Clerk authenticates the caller.
export interface MappedIdentity {
  clerkUserId: string
  supabaseUuid: string
  email: string
  role: MappedRole
}

@Injectable()
export class IdentityService {
  constructor(private readonly db: DbService) {}

  async hasEnabledAccess(storageUuid: string): Promise<boolean> {
    const rows = await this.db.query<{ access_allowed: boolean }>(
      `
      SELECT EXISTS(SELECT FROM public.user_access
        WHERE user_id=$1::uuid AND is_enabled=true
          AND (access_expires_at IS NULL OR access_expires_at>now())) AS access_allowed`,
      [storageUuid]
    )
    return rows[0]?.access_allowed === true
  }

  async resolve(clerkUserId: string): Promise<MappedIdentity | null> {
    const rows = await this.db.query<{
      supabase_uuid: string
      email: string
      role: MappedRole
    }>(
      "SELECT supabase_uuid, email, role FROM public.clerk_user_mapping WHERE clerk_user_id = $1",
      [clerkUserId]
    )
    const row = rows[0]
    if (row === undefined) return null
    return {
      clerkUserId,
      supabaseUuid: row.supabase_uuid,
      email: row.email,
      role: row.role,
    }
  }
}
