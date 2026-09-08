import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module.js"
import { DbModule } from "../db/db.module.js"
import { AdminEventEditorController } from "./admin-event-editor.controller.js"
import { AdminEventEditorRepository } from "./admin-event-editor.repository.js"
import { AdminEventEditorService } from "./admin-event-editor.service.js"
import { AdminReviewController } from "./admin-review.controller.js"
import { AdminReviewRepository } from "./admin-review.repository.js"
import { AdminReviewService } from "./admin-review.service.js"

@Module({
  imports: [AuthModule, DbModule],
  controllers: [AdminReviewController, AdminEventEditorController],
  providers: [
    AdminReviewService,
    AdminReviewRepository,
    AdminEventEditorService,
    AdminEventEditorRepository,
  ],
})
export class AdminModule {}
