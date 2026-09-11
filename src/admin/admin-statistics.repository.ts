import { Injectable } from "@nestjs/common"

import { DbService } from "../db/db.service.js"
import { requireDatabaseAdmin, withAdminActor } from "./admin-database.js"

@Injectable()
export class AdminStatisticsRepository {
  constructor(private readonly db: DbService) {}

  dashboard(actor: string): Promise<unknown> {
    return withAdminActor(this.db, actor, async (client) => {
      await requireDatabaseAdmin(client)
      const result = await client.query<{ stats: unknown }>(
        "SELECT public.admin_dashboard_stats() AS stats"
      )
      return result.rows[0]?.stats
    })
  }

  pipeline(actor: string, windowDays: number): Promise<unknown> {
    return withAdminActor(this.db, actor, async (client) => {
      // This check is deliberately explicit: pipeline_learning_stats' private
      // helper does not call private.is_admin(), and its public grant is weak.
      await requireDatabaseAdmin(client)
      const result = await client.query<{ stats: unknown }>(
        "SELECT public.pipeline_learning_stats($1::int) AS stats",
        [windowDays]
      )
      return result.rows[0]?.stats
    })
  }
}
