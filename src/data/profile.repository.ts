import { Injectable, NotFoundException } from "@nestjs/common"
import { DbService } from "../db/db.service.js"
import type { ProfileUpdate } from "../consumer/profile.input.js"

export interface UserProfile {
  display_name: string | null
  child_name: string | null
  child_age: number | null
  city_preference_id: string | null
  theme_preference: "light" | "dark" | "system" | null
}

const PROFILE_COLUMNS =
  "display_name, child_name, child_age, city_preference_id::text, theme_preference"

@Injectable()
export class ProfileRepository {
  constructor(private readonly db: DbService) {}

  async get(userId: string): Promise<UserProfile> {
    const [profile] = await this.db.query<UserProfile>(
      `SELECT ${PROFILE_COLUMNS}
       FROM public.user_profiles WHERE id = $1::uuid`,
      [userId]
    )
    if (!profile) throw new NotFoundException("Profile not found")
    return profile
  }

  async update(userId: string, input: ProfileUpdate): Promise<UserProfile> {
    const fields = (
      ["display_name", "child_name", "child_age", "theme_preference"] as const
    ).filter((field) => input[field] !== undefined)
    const values = fields.map((field) => input[field])
    const assignments = fields.map((field, index) => `${field} = $${index + 2}`).join(", ")
    const [profile] = await this.db.query<UserProfile>(
      `UPDATE public.user_profiles SET ${assignments}, updated_at = now()
       WHERE id = $1::uuid RETURNING ${PROFILE_COLUMNS}`,
      [userId, ...values]
    )
    if (!profile) throw new NotFoundException("Profile not found")
    return profile
  }
}
