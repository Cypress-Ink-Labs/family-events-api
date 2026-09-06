import { Injectable, Logger, Optional } from "@nestjs/common"

import { abortable } from "../common/abortable.js"
import { DbService } from "../db/db.service.js"

export interface TelegramRepositoryDependencies {
  timeoutMs?: number
}

interface TelegramCredentialRow {
  botToken: string | null
}

const LOAD_BOT_TOKEN_SQL = `
SELECT decrypted_secret AS "botToken"
FROM vault.decrypted_secrets
WHERE name = $1
LIMIT 1
`

@Injectable()
export class TelegramRepository {
  private readonly logger = new Logger(TelegramRepository.name)

  constructor(
    private readonly db: DbService,
    @Optional() private readonly dependencies: TelegramRepositoryDependencies = {}
  ) {}

  async loadBotToken(signal?: AbortSignal): Promise<string | null> {
    signal?.throwIfAborted()
    try {
      const timeout = AbortSignal.timeout(this.dependencies.timeoutMs ?? 2_000)
      const querySignal = signal ? AbortSignal.any([signal, timeout]) : timeout
      const rows = await abortable(
        () => this.db.query<TelegramCredentialRow>(LOAD_BOT_TOKEN_SQL, ["telegram_bot_token"]),
        querySignal
      )
      signal?.throwIfAborted()
      return rows[0]?.botToken?.trim() || null
    } catch {
      signal?.throwIfAborted()
      this.logger.warn("Telegram credential lookup failed: vault_unavailable")
      return null
    }
  }
}
