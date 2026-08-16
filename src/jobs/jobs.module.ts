import { Global, Module } from "@nestjs/common"

import { JobsService } from "./jobs.service.js"

@Global()
@Module({
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}
