import { Module } from "@nestjs/common"

import { CronGateService } from "./cron-gate.service.js"
import { FailurePingService } from "./failure-ping.service.js"
import { IngestionRepository } from "./ingestion/ingestion.repository.js"

/**
 * Pipeline infrastructure (U27). Stage workers (U28-U30) register their
 * pg-boss queues here as they are ported; until then no queue is installed
 * at boot and the Railway crons remain the single writer. IngestionRepository
 * (U28) is passive SQL access — providing it installs no queue and schedules
 * no work.
 */
@Module({
  providers: [CronGateService, FailurePingService, IngestionRepository],
  exports: [CronGateService, FailurePingService, IngestionRepository],
})
export class PipelineModule {}
