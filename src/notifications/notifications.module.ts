import { Module } from "@nestjs/common"

import { DataModule } from "../data/data.module.js"
import { PipelineModule } from "../pipeline/pipeline.module.js"
import { DigestQueueService } from "./digest-queue.service.js"
import { DigestRepository } from "./digest.repository.js"
import { DigestService } from "./digest.service.js"
import { MailService } from "./mail.service.js"
import { ReminderQueueService } from "./reminder-queue.service.js"
import { ReminderRepository } from "./reminder.repository.js"
import { ReminderService } from "./reminder.service.js"

@Module({
  imports: [DataModule, PipelineModule],
  providers: [
    DigestQueueService,
    DigestRepository,
    DigestService,
    MailService,
    ReminderQueueService,
    ReminderRepository,
    ReminderService,
  ],
  exports: [MailService],
})
export class NotificationsModule {}
