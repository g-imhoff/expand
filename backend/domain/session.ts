import type { DomainEvent } from "@yodea/shared/events"
import type { Session } from "@yodea/shared/session"

// Pure left-fold of the event log into the Session read-model.
// No I/O — this is the deterministic core of the projection. As new event
// types join the DomainEvent union, add a `case` here.
export const projectSessions = (
  events: ReadonlyArray<DomainEvent>
): ReadonlyArray<Session> => {
  const byId = new Map<string, Session>()
  for (const event of events) {
    switch (event._tag) {
      case "SessionCreated":
        byId.set(event.sessionId, {
          id: event.sessionId,
          title: event.title,
          createdAt: event.createdAt
        })
        break
    }
  }
  return [...byId.values()]
}
