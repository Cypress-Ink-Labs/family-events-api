import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module.js"
import { DataModule } from "../data/data.module.js"
import { ConsumerAccountReadController } from "./consumer-account-read.controller.js"
import { ConsumerWriteController } from "./consumer-write.controller.js"
import { ConsumerWriteService } from "./consumer-write.service.js"
import { ConsumerController } from "./consumer.controller.js"
import { ConsumerService } from "./consumer.service.js"
import { PlanController } from "./plan.controller.js"
import { WeatherService } from "./weather.service.js"

const CONSUMER_CONTROLLERS = [
  ConsumerController,
  ConsumerAccountReadController,
  PlanController,
  ConsumerWriteController,
]
const CONSUMER_PROVIDERS = [ConsumerService, WeatherService, ConsumerWriteService]

@Module({
  imports: [AuthModule, DataModule],
  controllers: CONSUMER_CONTROLLERS,
  providers: CONSUMER_PROVIDERS,
})
export class ConsumerModule {}
