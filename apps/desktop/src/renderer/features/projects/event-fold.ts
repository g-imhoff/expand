import type { Project } from "@yodea/contracts/project"
import type { DomainEvent } from "@yodea/contracts/events"

// Pure fold of one live DomainEvent into the project list. Idempotent on id so a
// replayed/duplicated event (or a snapshot that already contains it) never dupes.
// DOM-free so it is Bun-testable. Mirrors apps/cli/domain/project.ts.
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
  }
}
