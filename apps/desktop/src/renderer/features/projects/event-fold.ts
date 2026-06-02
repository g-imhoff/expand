import type { Project } from "@yodea/contracts/project"
import type { DomainEvent } from "@yodea/contracts/events"

export const foldEvent = (
  list: ReadonlyArray<Project>,
  event: DomainEvent
): ReadonlyArray<Project> => {
  switch (event._tag) {
    case "ProjectCreated":
      return list.some((p) => p.id === event.projectId)
        ? list
        : [...list, {
            id: event.projectId,
            name: event.name,
            directory: event.directory ?? null,
            description: null,
            tags: [],
            archived: false,
            createdAt: event.createdAt,
            updatedAt: event.createdAt
          }]
    case "ProjectRenamed":
      return list.map((p) =>
        p.id === event.projectId ? { ...p, name: event.name, updatedAt: event.occurredAt } : p)
    case "ProjectDirectoryChanged":
      return list.map((p) =>
        p.id === event.projectId ? { ...p, directory: event.directory, updatedAt: event.occurredAt } : p)
    case "ProjectArchived":
      return list.map((p) =>
        p.id === event.projectId ? { ...p, archived: true, updatedAt: event.occurredAt } : p)
    case "ProjectRestored":
      return list.map((p) =>
        p.id === event.projectId ? { ...p, archived: false, updatedAt: event.occurredAt } : p)
    case "ProjectMetadataChanged":
      return list.map((p) =>
        p.id === event.projectId
          ? {
              ...p,
              ...(event.description !== undefined ? { description: event.description } : {}),
              ...(event.tags !== undefined ? { tags: [...new Set(event.tags)] } : {}),
              updatedAt: event.occurredAt
            }
          : p)
    case "ProjectDeleted":
      return list.filter((p) => p.id !== event.projectId)
    default:
      return list
  }
}
