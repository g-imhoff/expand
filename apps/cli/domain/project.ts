import type { DomainEvent } from "@yodea/contracts/events/domain"
import type { Project } from "@yodea/contracts/project"

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
          createdAt: event.occurredAt,
          updatedAt: event.occurredAt
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
      case "ProjectArchived": {
        const existing = byId.get(event.projectId)
        if (existing === undefined) break
        byId.set(event.projectId, { ...existing, archived: true, updatedAt: event.occurredAt })
        break
      }
      case "ProjectRestored": {
        const existing = byId.get(event.projectId)
        if (existing === undefined) break
        byId.set(event.projectId, { ...existing, archived: false, updatedAt: event.occurredAt })
        break
      }
      case "ProjectMetadataChanged": {
        const existing = byId.get(event.projectId)
        if (existing === undefined) break
        byId.set(event.projectId, {
          ...existing,
          ...(event.description !== undefined ? { description: event.description } : {}),
          ...(event.tags !== undefined ? { tags: [...new Set(event.tags)] } : {}),
          updatedAt: event.occurredAt
        })
        break
      }
      case "ProjectDeleted":
        byId.delete(event.projectId)
        break
    }
  }
  return [...byId.values()]
}
