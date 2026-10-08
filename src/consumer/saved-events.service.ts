import { Injectable } from "@nestjs/common"
import { EventsRepository } from "../data/events.repository.js"
import { SavedEventsRepository } from "../data/saved-events.repository.js"
import type { SavedEventsDto } from "./saved-events.dto.js"

@Injectable()
export class SavedEventsService {
  constructor(
    private readonly saved: SavedEventsRepository,
    private readonly events: EventsRepository
  ) {}

  async remove(userId: string, eventId: string): Promise<{ ok: true }> {
    await this.saved.remove(userId, eventId)
    return { ok: true }
  }

  async list(userId: string): Promise<SavedEventsDto> {
    const records = await this.saved.list(userId)
    if (!records.length) return { events: [] }
    const metadata = new Map(records.map((row) => [row.event_id, row]))
    const events = await this.events.listEvents({
      eventIds: records.map((row) => row.event_id),
      userKey: userId,
      limit: records.length,
    })
    return {
      events: events.map((event) => ({
        ...event,
        calendar_notes: metadata.get(event.id)!.calendar_notes,
        calendar_added_at: metadata.get(event.id)!.calendar_added_at,
        my_rating: metadata.get(event.id)!.my_rating,
      })),
    }
  }
}
