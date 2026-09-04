import { Module } from "@nestjs/common"

import { DataModule } from "../data/data.module.js"
import { PipelineModule } from "../pipeline/pipeline.module.js"
import { DigestQueueService } from "./digest-queue.service.js"
import { DigestRepository } from "./digest.repository.js"
import { DigestService } from "./digest.service.js"
import { MailService } from "./mail.service.js"
import { NotificationQueueRepository } from "./notification-queue.repository.js"
import { NotificationQueueService } from "./notification-queue.service.js"
import { NotifyQueueService } from "./notify-queue.service.js"
import { PushRepository } from "./push.repository.js"
import { PushService } from "./push.service.js"
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
    NotificationQueueRepository,
    NotificationQueueService,
    NotifyQueueService,
    PushRepository,
    PushService,
    ReminderQueueService,
    ReminderRepository,
    ReminderService,
  ],
  exports: [MailService, PushService],
})
export class NotificationsModule {}
