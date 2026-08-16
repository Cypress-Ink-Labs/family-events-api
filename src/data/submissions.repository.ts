import { Injectable } from "@nestjs/common"

import { DbService } from "../db/db.service.js"
import type { CommunityEventInput } from "./types.js"

// Ported from family-events-app src/server/submissions.ts

export class SubmissionLimitError extends Error {
  readonly status = 429
  constructor() {
    super("Daily submission limit reached (max 5 per day)")
    this.name = "SubmissionLimitError"
  }
}

const DAILY_LIMIT = 5

const RECENT_COUNT_SQL = `
SELECT count(*)::int AS count
FROM public.events
WHERE submitted_by = $1::uuid
  AND source_name = 'community'
  AND created_at > now() - interval '24 hours'
`

const INSERT_SQL = `
INSERT INTO public.events (
  title, description, start_datetime, end_datetime, venue_name, address,
  city_id, age_min, age_max, is_free, price,
  status, source_name, submitted_by, ai_confidence, llm_review_status
) VALUES (
  $1, $2, $3, $4, $5, $6,
  $7::uuid, $8, $9, $10, $11,
  'draft', 'community', $12::uuid, 0, 'not_required'
)
RETURNING id::text
`

function normalized(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? ""
  return trimmed === "" ? null : trimmed
}

@Injectable()
export class SubmissionsRepository {
  constructor(private readonly db: DbService) {}

  async submitCommunityEvent(userKey: string, input: CommunityEventInput): Promise<{ id: string }> {
    const title = normalized(input.title)
    if (!title) throw new Error("Title is required")
    if (!input.startDatetime) throw new Error("Start date/time is required")
    if (!input.cityId) throw new Error("City is required")

    const isFree = input.isFree ?? true

    return this.db.withTransaction(async (client) => {
      const recent = await client.query<{ count: number }>(RECENT_COUNT_SQL, [userKey])
      if ((recent.rows[0]?.count ?? 0) >= DAILY_LIMIT) {
        throw new SubmissionLimitError()
      }

      const inserted = await client.query<{ id: string }>(INSERT_SQL, [
        title,
        normalized(input.description),
        input.startDatetime,
        input.endDatetime ?? null,
        normalized(input.venueName),
        normalized(input.address),
        input.cityId,
        input.ageMin ?? null,
        input.ageMax ?? null,
        isFree,
        isFree ? null : (input.price ?? null),
        userKey,
      ])
      return inserted.rows[0]!
    })
  }
}
