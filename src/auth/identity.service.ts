import { Injectable } from "@nestjs/common"

import { DbService } from "../db/db.service.js"

export type MappedRole = "operator" | "member"

/**
 * U22: the identity seam in uuid-mapping mode (pre-U7 cutover).
 * A verified Clerk session resolves through public.clerk_user_mapping (U19)
 * to the supabase uuid that user-keyed tables still use. U7 retypes those
 * keys to Clerk text IDs at cutover, at which point this seam collapses.
 */
export interface MappedIdentity {
  clerkUserId: string
  supabaseUuid: string
  email: string
  role: MappedRole
}

@Injectable()
export class IdentityService {
  constructor(private readonly db: DbService) {}

  /** Returns null for Clerk users that were never provisioned (U19 script). */
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
