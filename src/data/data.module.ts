import { Module } from "@nestjs/common"

import { CalendarRepository } from "./calendar.repository.js"
import { CommentsRepository } from "./comments.repository.js"
import { EventsRepository } from "./events.repository.js"
import { FavoritesRepository } from "./favorites.repository.js"
import { PreferredCitiesRepository } from "./preferred-cities.repository.js"
import { RatingsRepository } from "./ratings.repository.js"
import { ReferenceRepository } from "./reference.repository.js"
import { SubmissionsRepository } from "./submissions.repository.js"

@Module({
  providers: [
    EventsRepository,
    ReferenceRepository,
    FavoritesRepository,
    CalendarRepository,
    RatingsRepository,
    CommentsRepository,
    SubmissionsRepository,
    PreferredCitiesRepository,
  ],
  exports: [
    EventsRepository,
    ReferenceRepository,
    FavoritesRepository,
    CalendarRepository,
    RatingsRepository,
    CommentsRepository,
    SubmissionsRepository,
    PreferredCitiesRepository,
  ],
})
export class DataModule {}
