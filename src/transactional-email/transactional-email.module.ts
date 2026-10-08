import { Module } from "@nestjs/common"
import { MailService } from "../notifications/mail.service.js"
import { AuthModule } from "../auth/auth.module.js"
import { TransactionalEmailController } from "./transactional-email.controller.js"
import { TransactionalEmailService } from "./transactional-email.service.js"

@Module({
  imports: [AuthModule],
  controllers: [TransactionalEmailController],
  providers: [TransactionalEmailService, MailService],
})
export class TransactionalEmailModule {}
