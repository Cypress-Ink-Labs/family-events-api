import { Module } from "@nestjs/common"

import { AuthModule } from "../auth/auth.module.js"
import { DbModule } from "../db/db.module.js"
import { JobsModule } from "../jobs/jobs.module.js"
import { AdminEventEditorController } from "./admin-event-editor.controller.js"
import { AdminEventEditorRepository } from "./admin-event-editor.repository.js"
import { AdminEventEditorService } from "./admin-event-editor.service.js"
import { AdminReviewController } from "./admin-review.controller.js"
import { AdminReviewRepository } from "./admin-review.repository.js"
import { AdminReviewService } from "./admin-review.service.js"
import { AdminSourceController } from "./admin-source.controller.js"
import { AdminSourceRepository } from "./admin-source.repository.js"
import { AdminSourceService } from "./admin-source.service.js"

@Module({
  imports: [AuthModule, DbModule, JobsModule],
  controllers: [AdminReviewController, AdminEventEditorController, AdminSourceController],
  providers: [
    AdminReviewService,
    AdminReviewRepository,
    AdminEventEditorService,
    AdminEventEditorRepository,
    AdminSourceService,
    AdminSourceRepository,
  ],
})
export class AdminModule {}
