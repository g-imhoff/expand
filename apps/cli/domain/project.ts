import type { DomainEvent } from "@yodea/contracts/events"
import type { Project } from "@yodea/contracts/project"

// Pure left-fold of the event log into the Project read-model.
// No I/O — this is the deterministic core of the projection. As new event
// types join the DomainEvent union, add a `case` here.
export const projectsFromEvents = (
  events: ReadonlyArray<DomainEvent>
): ReadonlyArray<Project> => {
  const byId = new Map<string, Project>()
  for (const event of events) {
    switch (event._tag) {
      case "ProjectCreated":
        byId.set(event.projectId, {
          id: event.projectId,
          name: event.name,
          directory: event.directory ?? null,
          description: null,
          tags: [],
          archived: false,
          createdAt: event.createdAt,
          updatedAt: event.createdAt
        })
        break
      case "ProjectRenamed": {
        const existing = byId.get(event.projectId)
        if (existing === undefined) break
        byId.set(event.projectId, { ...existing, name: event.name, updatedAt: event.occurredAt })
        break
      }
      case "ProjectDirectoryChanged": {
        const existing = byId.get(event.projectId)
        if (existing === undefined) break
        byId.set(event.projectId, { ...existing, directory: event.directory, updatedAt: event.occurredAt })
        break
      }
    }
  }
  return [...byId.values()]
}
