import { Module } from "@nestjs/common"
import { ConfigModule } from "@nestjs/config"

import { AuthModule } from "./auth/auth.module.js"
import { validateEnv } from "./config/env.js"
import { ConsumerModule } from "./consumer/consumer.module.js"
import { DataModule } from "./data/data.module.js"
import { DbModule } from "./db/db.module.js"
import { HealthModule } from "./health/health.module.js"
import { JobsModule } from "./jobs/jobs.module.js"
import { PipelineModule } from "./pipeline/pipeline.module.js"

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    DbModule,
    DataModule,
    JobsModule,
    AuthModule,
    ConsumerModule,
    PipelineModule,
    HealthModule,
  ],
})
export class AppModule {}
