import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module.js"
import { DataModule } from "../data/data.module.js"
import { ConsumerWriteController } from "./consumer-write.controller.js"
import { ConsumerWriteService } from "./consumer-write.service.js"
import { ConsumerController } from "./consumer.controller.js"
import { ConsumerService } from "./consumer.service.js"

const CONSUMER_CONTROLLERS = [ConsumerController, ConsumerWriteController]
const CONSUMER_PROVIDERS = [ConsumerService, ConsumerWriteService]

@Module({
  imports: [AuthModule, DataModule],
  controllers: CONSUMER_CONTROLLERS,
  providers: CONSUMER_PROVIDERS,
})
export class ConsumerModule {}
