import { Module } from "@nestjs/common"
import { DbModule } from "../db/db.module.js"
import { AccountDeletionService } from "./account-deletion.service.js"
@Module({
  imports: [DbModule],
  providers: [AccountDeletionService],
  exports: [AccountDeletionService],
})
export class UserAccessModule {}
