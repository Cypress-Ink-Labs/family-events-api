import { Module } from "@nestjs/common"

import { ClassificationRepository } from "./classification/classification.repository.js"
import { CronGateService } from "./cron-gate.service.js"
import { FailurePingService } from "./failure-ping.service.js"
import { IngestionRepository } from "./ingestion/ingestion.repository.js"
import { ScrapeQueueService } from "./ingestion/scrape-queue.service.js"

/**
 * Pipeline infrastructure (U27). Stage workers register their pg-boss queues
 * here as they are ported; the scrape family (U28) installs behind the
 * CUTOVER_SCRAPE creation-time gate — in production the queue, schedules, and
 * workers simply do not exist until the flag flips, so the Railway crons
 * remain the single writer. IngestionRepository is passive SQL access.
 */
@Module({
  providers: [
    ClassificationRepository,
    CronGateService,
    FailurePingService,
    IngestionRepository,
    ScrapeQueueService,
  ],
  exports: [ClassificationRepository, CronGateService, FailurePingService, IngestionRepository],
})
export class PipelineModule {}
