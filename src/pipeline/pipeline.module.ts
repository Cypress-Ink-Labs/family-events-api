import { Module } from "@nestjs/common"

import { CronGateService } from "./cron-gate.service.js"

/**
 * Pipeline infrastructure (U27). Stage workers (U28-U30) register their
 * pg-boss queues here as they are ported; until then no queue is installed
 * at boot and the Railway crons remain the single writer.
 */
@Module({
  providers: [CronGateService],
  exports: [CronGateService],
})
export class PipelineModule {}
