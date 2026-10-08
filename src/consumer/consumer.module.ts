import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module.js"
import { DataModule } from "../data/data.module.js"
import { ConsumerAccountReadController } from "./consumer-account-read.controller.js"
import { ConsumerWriteController } from "./consumer-write.controller.js"
import { ConsumerWriteService } from "./consumer-write.service.js"
import { ConsumerController } from "./consumer.controller.js"
import { ConsumerService } from "./consumer.service.js"
import { PlanController } from "./plan.controller.js"
import { ProfileController } from "./profile.controller.js"
import { NotificationController } from "./notification.controller.js"
import { NotificationPreferencesController } from "./notification-preferences.controller.js"
import { NotificationPreferencesService } from "./notification-preferences.service.js"
import { PushRepository } from "../notifications/push.repository.js"
import { WeatherService } from "./weather.service.js"
import {
  CorrectionReportCapabilityController,
  CorrectionReportController,
} from "./correction-report.controller.js"
import { CorrectionReportService } from "./correction-report.service.js"

const CONSUMER_CONTROLLERS = [
  ConsumerController,
  ConsumerAccountReadController,
  PlanController,
  ProfileController,
  NotificationController,
  NotificationPreferencesController,
  ConsumerWriteController,
  CorrectionReportController,
  CorrectionReportCapabilityController,
]
const CONSUMER_PROVIDERS = [
  NotificationPreferencesService,
  PushRepository,
  ConsumerService,
  WeatherService,
  ConsumerWriteService,
  CorrectionReportService,
]

@Module({
  imports: [AuthModule, DataModule],
  controllers: CONSUMER_CONTROLLERS,
  providers: CONSUMER_PROVIDERS,
})
export class ConsumerModule {}
