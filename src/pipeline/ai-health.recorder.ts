import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common"

import { DbService } from "../db/db.service.js"
import { setAiOutcomeRecorder, type AiCallOutcome } from "./ai-health.js"

const RECORD_OUTCOME_SQL = `INSERT INTO private.ai_call_health
  (feature, provider, model, last_success_at, last_failure_at, last_failure_reason, updated_at)
VALUES ($1, $2, $3,
  CASE WHEN $4::text IS NULL THEN now() END,
  CASE WHEN $4::text IS NOT NULL THEN now() END,
  $4::text, now())
ON CONFLICT (feature) DO UPDATE SET
  provider = excluded.provider,
  model = excluded.model,
  last_success_at = COALESCE(excluded.last_success_at, private.ai_call_health.last_success_at),
  last_failure_at = COALESCE(excluded.last_failure_at, private.ai_call_health.last_failure_at),
  last_failure_reason = COALESCE(excluded.last_failure_reason, private.ai_call_health.last_failure_reason),
  updated_at = excluded.updated_at`

/** Persists the latest provider call outcome per AI feature for the dashboard. */
@Injectable()
export class AiHealthRecorder implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly db: DbService) {}

  onModuleInit(): void {
    setAiOutcomeRecorder((outcome) => this.record(outcome))
  }

  onModuleDestroy(): void {
    setAiOutcomeRecorder(null)
  }

  async record(outcome: AiCallOutcome): Promise<void> {
    await this.db.query(RECORD_OUTCOME_SQL, [
      outcome.feature,
      outcome.provider,
      outcome.model,
      outcome.failure,
    ])
  }
}
