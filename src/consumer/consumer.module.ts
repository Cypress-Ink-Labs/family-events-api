import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module.js"
import { DataModule } from "../data/data.module.js"
import { ConsumerController } from "./consumer.controller.js"
import { ConsumerService } from "./consumer.service.js"

@Module({
  imports: [AuthModule, DataModule],
  controllers: [ConsumerController],
  providers: [ConsumerService],
})
export class ConsumerModule {}
