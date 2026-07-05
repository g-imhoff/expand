import type { DomainEvent } from "@yodea/contracts/events/domain"
import { Project } from "@yodea/contracts/project"

// The incremental fold step over a mutable accumulator — the boot rebuild
// applies it chunk by chunk so the full log never resides in memory at once.
export const foldProjectsInto = (byId: Map<string, Project>, event: DomainEvent): void => {
  switch (event._tag) {
    case "ProjectCreated":
      // first-create-wins, matching Project.foldList and the test's stated
      // intent ("does not duplicate or reset"); duplicate creates are
      // unreachable via the domain (fresh UUID per create, ensure emits no event)
      if (!byId.has(event.projectId)) byId.set(event.projectId, Project.fromCreated(event))
      break
    case "ProjectDeleted":
      byId.delete(event.projectId)
      break
    default: {
      const existing = byId.get(event.projectId)
      if (existing !== undefined) byId.set(event.projectId, Project.applyEvent(existing, event))
    }
  }
}

export const projectsFromEvents = (
  events: ReadonlyArray<DomainEvent>
): ReadonlyArray<Project> => {
  const byId = new Map<string, Project>()
  for (const event of events) foldProjectsInto(byId, event)
  return [...byId.values()]
}
