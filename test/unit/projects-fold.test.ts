import { describe, expect, it } from "vitest"
import { projectsFromEvents } from "@yodea/domain/project"
import { ProjectArchived, ProjectCreated, ProjectDeleted, ProjectDirectoryChanged, ProjectMetadataChanged, ProjectRenamed, ProjectRestored } from "@yodea/contracts/events"

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

describe("projectsFromEvents — archive/restore", () => {
  it("ProjectArchived sets archived:true and stamps updatedAt", () => {
    const [p] = projectsFromEvents([
      ProjectCreated.make({ projectId: "p1", name: "A", createdAt: "t1" }),
      ProjectArchived.make({ projectId: "p1", occurredAt: "t2" })
    ])
    expect(p?.archived).toBe(true)
    expect(p?.updatedAt).toBe("t2")
    expect(p?.createdAt).toBe("t1")
  })
  it("ProjectRestored sets archived:false and stamps updatedAt", () => {
    const [p] = projectsFromEvents([
      ProjectCreated.make({ projectId: "p1", name: "A", createdAt: "t1" }),
      ProjectArchived.make({ projectId: "p1", occurredAt: "t2" }),
      ProjectRestored.make({ projectId: "p1", occurredAt: "t3" })
    ])
    expect(p?.archived).toBe(false)
    expect(p?.updatedAt).toBe("t3")
  })
  it("ignores an archive for an unknown project (out-of-order tolerance)", () => {
    expect(projectsFromEvents([ProjectArchived.make({ projectId: "ghost", occurredAt: "t1" })])).toEqual([])
  })
})

describe("projectsFromEvents — ProjectMetadataChanged", () => {
  const created = ProjectCreated.make({ projectId: "p1", name: "A", createdAt: "t1" })

  it("merges only provided fields and stamps updatedAt from occurredAt", () => {
    const projects = projectsFromEvents([
      created,
      ProjectMetadataChanged.make({ projectId: "p1", description: "hello", occurredAt: "t2" })
    ])
    expect(projects).toEqual([
      { id: "p1", name: "A", directory: null, description: "hello", tags: [], archived: false, createdAt: "t1", updatedAt: "t2" }
    ])
  })

  it("dedupes tags and leaves description unchanged when absent", () => {
    const projects = projectsFromEvents([
      created,
      ProjectMetadataChanged.make({ projectId: "p1", tags: ["x", "x", "y"], occurredAt: "t3" })
    ])
    expect(projects[0]?.tags).toEqual(["x", "y"])
    expect(projects[0]?.description).toBe(null)
    expect(projects[0]?.updatedAt).toBe("t3")
  })

  it("sets description to null when description:null is provided", () => {
    const projects = projectsFromEvents([
      ProjectCreated.make({ projectId: "p1", name: "A", createdAt: "t1" }),
      ProjectMetadataChanged.make({ projectId: "p1", description: "x", occurredAt: "t2" }),
      ProjectMetadataChanged.make({ projectId: "p1", description: null, occurredAt: "t3" })
    ])
    expect(projects[0]?.description).toBe(null)
  })

  it("is a no-op for an unknown project id (out-of-order tolerance)", () => {
    const projects = projectsFromEvents([
      ProjectMetadataChanged.make({ projectId: "ghost", tags: ["x"], occurredAt: "t2" })
    ])
    expect(projects).toEqual([])
  })
})

describe("projectsFromEvents — ProjectDeleted", () => {
  it("removes a project from the read-model (tombstone)", () => {
    const projects = projectsFromEvents([
      ProjectCreated.make({ projectId: "p1", name: "A", createdAt: "t1" }),
      ProjectCreated.make({ projectId: "p2", name: "B", createdAt: "t2" }),
      ProjectDeleted.make({ projectId: "p1", occurredAt: "t3" })
    ])
    expect(projects.map((p) => p.id)).toEqual(["p2"])
  })
  it("a delete with no prior Created is a no-op (out-of-order tolerance)", () => {
    expect(projectsFromEvents([ProjectDeleted.make({ projectId: "ghost", occurredAt: "t1" })])).toEqual([])
  })
})
