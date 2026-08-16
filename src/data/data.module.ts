import { Module } from "@nestjs/common"

import { EventsRepository } from "./events.repository.js"
import { ReferenceRepository } from "./reference.repository.js"

@Module({
  providers: [EventsRepository, ReferenceRepository],
  exports: [EventsRepository, ReferenceRepository],
})
export class DataModule {}
