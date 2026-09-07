import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module.js"
import { DbModule } from "../db/db.module.js"
import { AdminReviewController } from "./admin-review.controller.js"
import { AdminReviewRepository } from "./admin-review.repository.js"
import { AdminReviewService } from "./admin-review.service.js"

@Module({
  imports: [AuthModule, DbModule],
  controllers: [AdminReviewController],
  providers: [AdminReviewService, AdminReviewRepository],
})
export class AdminModule {}
