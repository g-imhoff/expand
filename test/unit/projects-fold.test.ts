import { describe, expect, it } from "vitest"
import { projectsFromEvents } from "@yodea/domain/project"
import { ProjectCreated, ProjectDirectoryChanged, ProjectRenamed } from "@yodea/contracts/events"

describe("projectsFromEvents", () => {
  it("folds an empty log into no projects", () => {
    expect(projectsFromEvents([])).toEqual([])
  })

  it("folds ProjectCreated events into the read-model", () => {
    const projects = projectsFromEvents([
      ProjectCreated.make({ projectId: "p1", name: "A", createdAt: "t1" }),
      ProjectCreated.make({ projectId: "p2", name: "B", createdAt: "t2" })
    ])
    expect(projects).toEqual([
      { id: "p1", name: "A", directory: null, description: null, tags: [], archived: false, createdAt: "t1", updatedAt: "t1" },
      { id: "p2", name: "B", directory: null, description: null, tags: [], archived: false, createdAt: "t2", updatedAt: "t2" }
    ])
  })

  it("ProjectRenamed updates name and stamps updatedAt from occurredAt", () => {
    const projects = projectsFromEvents([
      ProjectCreated.make({ projectId: "p1", name: "A", directory: null, createdAt: "t1" }),
      ProjectRenamed.make({ projectId: "p1", name: "A2", occurredAt: "t2" })
    ])
    expect(projects).toEqual([
      { id: "p1", name: "A2", directory: null, description: null, tags: [], archived: false, createdAt: "t1", updatedAt: "t2" }
    ])
  })

  it("ProjectRenamed with no prior Created is a no-op (out-of-order tolerance)", () => {
    expect(projectsFromEvents([ProjectRenamed.make({ projectId: "ghost", name: "X", occurredAt: "t9" })])).toEqual([])
  })

  it("ProjectDirectoryChanged sets directory + updatedAt on an existing project", () => {
    const projects = projectsFromEvents([
      ProjectCreated.make({ projectId: "p1", name: "A", directory: null, createdAt: "t1" }),
      ProjectDirectoryChanged.make({ projectId: "p1", directory: "/srv/p1", occurredAt: "t2" })
    ])
    expect(projects).toEqual([
      { id: "p1", name: "A", directory: "/srv/p1", description: null, tags: [], archived: false, createdAt: "t1", updatedAt: "t2" }
    ])
  })

  it("ProjectDirectoryChanged for an unknown id is a no-op", () => {
    expect(projectsFromEvents([
      ProjectDirectoryChanged.make({ projectId: "ghost", directory: "/srv/x", occurredAt: "t9" })
    ])).toEqual([])
  })
})
