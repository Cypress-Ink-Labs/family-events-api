import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"
import { Pool, types, type PoolClient, type QueryResultRow } from "pg"

import type { Env } from "../config/env.js"

// timestamptz/timestamp come back as microsecond-precision text, not JS Date.
// Keyset cursors compare these strings lexicographically; Date would lose precision.
// (Convention carried over from the app data layer, U6.)
types.setTypeParser(types.builtins.TIMESTAMPTZ, (value) => value)
types.setTypeParser(types.builtins.TIMESTAMP, (value) => value)

@Injectable()
export class DbService implements OnModuleDestroy {
  private readonly logger = new Logger(DbService.name)
  readonly pool: Pool

  constructor(config: ConfigService<Env, true>) {
    this.pool = new Pool({
      connectionString: config.get("DATABASE_URL", { infer: true }),
      max: 10,
    })
    this.pool.on("error", (error) => {
      this.logger.error(`idle client error: ${error.message}`)
    })
  }

  async query<Row extends QueryResultRow>(text: string, params?: unknown[]): Promise<Row[]> {
    const result = await this.pool.query<Row>(text, params)
    return result.rows
  }

  async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      const value = await fn(client)
      await client.query("COMMIT")
      return value
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1")
      return true
    } catch {
      return false
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end()
  }
}
