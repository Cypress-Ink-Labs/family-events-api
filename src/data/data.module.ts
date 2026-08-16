import { Module } from "@nestjs/common"

import { EventsRepository } from "./events.repository.js"
import { ReferenceRepository } from "./reference.repository.js"

/** U23: consumer data-access layer serving the app's existing wire contract. */
@Module({
  providers: [EventsRepository, ReferenceRepository],
  exports: [EventsRepository, ReferenceRepository],
})
export class DataModule {}
