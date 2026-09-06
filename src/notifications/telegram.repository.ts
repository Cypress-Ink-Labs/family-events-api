import { Injectable, Logger } from "@nestjs/common"

import { DbService } from "../db/db.service.js"

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

  constructor(private readonly db: DbService) {}

  async loadBotToken(): Promise<string | null> {
    try {
      const rows = await this.db.query<TelegramCredentialRow>(LOAD_BOT_TOKEN_SQL, [
        "telegram_bot_token",
      ])
      return rows[0]?.botToken?.trim() || null
    } catch {
      this.logger.warn("Telegram credential lookup failed: vault_unavailable")
      return null
    }
  }
}
