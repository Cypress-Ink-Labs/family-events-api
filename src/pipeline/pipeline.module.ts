import { Module } from "@nestjs/common"

import { ClassificationRepository } from "./classification/classification.repository.js"
import { TagQueueService } from "./classification/tag-queue.service.js"
import { CronGateService } from "./cron-gate.service.js"
import { EnrichmentRepository } from "./enrichment/enrichment.repository.js"
import { FailurePingService } from "./failure-ping.service.js"
import { IngestionRepository } from "./ingestion/ingestion.repository.js"
import { ScrapeQueueService } from "./ingestion/scrape-queue.service.js"
import { ReviewQueueService } from "./review/review-queue.service.js"
import { ReviewRepository } from "./review/review.repository.js"

/**
 * Pipeline infrastructure (U27). Stage workers register their pg-boss queues
 * here as they are ported. Scrape (U28), tag, enrichment, and review (U29)
 * install behind their family creation-time gates — in production their
 * queues, schedules, and workers do not exist until each flag flips, so the
 * Railway crons remain the single writer. Repositories are passive SQL access.
 */
@Module({
  providers: [
    ClassificationRepository,
    CronGateService,
    EnrichmentRepository,
    FailurePingService,
    IngestionRepository,
    ReviewQueueService,
    ReviewRepository,
    ScrapeQueueService,
    TagQueueService,
  ],
  exports: [
    ClassificationRepository,
    CronGateService,
    EnrichmentRepository,
    FailurePingService,
    IngestionRepository,
    ReviewQueueService,
    ReviewRepository,
    TagQueueService,
  ],
})
export class PipelineModule {}
