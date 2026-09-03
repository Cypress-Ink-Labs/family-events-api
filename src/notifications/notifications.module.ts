import { Module } from "@nestjs/common"

import { DataModule } from "../data/data.module.js"
import { MailService } from "./mail.service.js"

@Module({
  imports: [DataModule],
  providers: [MailService],
  exports: [MailService],
})
export class NotificationsModule {}
