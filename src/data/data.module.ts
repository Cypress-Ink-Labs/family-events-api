import { Module } from "@nestjs/common"

import { CitiesRepository } from "./cities.repository.js"
import { EventsRepository } from "./events.repository.js"

@Module({
  providers: [EventsRepository, CitiesRepository],
  exports: [EventsRepository, CitiesRepository],
})
export class DataModule {}
