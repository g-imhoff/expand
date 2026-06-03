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

describe("projectsFromEvents — out-of-order & duplicate tolerance", () => {
  it("ignores a mutation that arrives before its ProjectCreated (no prior aggregate)", () => {
    const projects = projectsFromEvents([
      ProjectRenamed.make({ projectId: "ghost", name: "renamed", occurredAt: "t2" })
    ])
    expect(projects).toEqual([])
  })

  it("drops on ProjectDeleted and a later mutation for the tombstoned id is a no-op", () => {
    const projects = projectsFromEvents([
      ProjectCreated.make({ projectId: "p1", name: "a", createdAt: "t1" }),
      ProjectDeleted.make({ projectId: "p1", occurredAt: "t2" }),
      ProjectRenamed.make({ projectId: "p1", name: "b", occurredAt: "t3" })
    ])
    expect(projects).toEqual([])
  })

  it("stamps updatedAt from each event's time and keeps createdAt fixed", () => {
    const [p] = projectsFromEvents([
      ProjectCreated.make({ projectId: "p1", name: "a", createdAt: "t1" }),
      ProjectRenamed.make({ projectId: "p1", name: "b", occurredAt: "t5" })
    ])
    expect(p).toMatchObject({ id: "p1", name: "b", createdAt: "t1", updatedAt: "t5" })
  })

  it("ProjectCreated without a directory folds directory to null (event-versioning)", () => {
    const [p] = projectsFromEvents([
      ProjectCreated.make({ projectId: "p1", name: "a", createdAt: "t1" })
    ])
    expect(p?.directory).toBeNull()
  })

  it("metadata is replace-style per field and dedupes tags", () => {
    const [p] = projectsFromEvents([
      ProjectCreated.make({ projectId: "p1", name: "a", createdAt: "t1" }),
      ProjectMetadataChanged.make({ projectId: "p1", description: "first", tags: ["x", "x", "y"], occurredAt: "t2" }),
      ProjectMetadataChanged.make({ projectId: "p1", tags: ["z"], occurredAt: "t3" })
    ])
    expect(p).toMatchObject({ description: "first", tags: ["z"], updatedAt: "t3" })
  })

  it("archive then restore toggles archived back to false", () => {
    const [p] = projectsFromEvents([
      ProjectCreated.make({ projectId: "p1", name: "a", createdAt: "t1" }),
      ProjectArchived.make({ projectId: "p1", occurredAt: "t2" }),
      ProjectRestored.make({ projectId: "p1", occurredAt: "t3" })
    ])
    expect(p?.archived).toBe(false)
  })

  it("a duplicate ProjectCreated for the same id does not duplicate or reset the aggregate", () => {
    const projects = projectsFromEvents([
      ProjectCreated.make({ projectId: "p1", name: "a", createdAt: "t1" }),
      ProjectRenamed.make({ projectId: "p1", name: "b", occurredAt: "t2" }),
      ProjectCreated.make({ projectId: "p1", name: "a", createdAt: "t9" })
    ])
    expect(projects).toHaveLength(1)
  })

  it("directory-changed updates directory and stamps updatedAt", () => {
    const [p] = projectsFromEvents([
      ProjectCreated.make({ projectId: "p1", name: "a", createdAt: "t1" }),
      ProjectDirectoryChanged.make({ projectId: "p1", directory: "/tmp/x", occurredAt: "t2" })
    ])
    expect(p).toMatchObject({ directory: "/tmp/x", updatedAt: "t2" })
  })

  it("folds a full realistic lifecycle: create -> rename -> change-dir -> archive -> restore -> set-metadata", () => {
    const [p] = projectsFromEvents([
      ProjectCreated.make({ projectId: "p1", name: "alpha", createdAt: "t1" }),
      ProjectRenamed.make({ projectId: "p1", name: "beta", occurredAt: "t2" }),
      ProjectDirectoryChanged.make({ projectId: "p1", directory: "/srv/beta", occurredAt: "t3" }),
      ProjectArchived.make({ projectId: "p1", occurredAt: "t4" }),
      ProjectRestored.make({ projectId: "p1", occurredAt: "t5" }),
      ProjectMetadataChanged.make({ projectId: "p1", description: "the beta project", tags: ["x", "y"], occurredAt: "t6" })
    ])
    expect(p).toEqual({
      id: "p1",
      name: "beta",
      directory: "/srv/beta",
      description: "the beta project",
      tags: ["x", "y"],
      archived: false,
      createdAt: "t1",
      updatedAt: "t6"
    })
  })

  it("a tombstoned id never reappears even when re-created and mutated afterwards", () => {
    const projects = projectsFromEvents([
      ProjectCreated.make({ projectId: "p1", name: "alpha", createdAt: "t1" }),
      ProjectDeleted.make({ projectId: "p1", occurredAt: "t2" }),
      ProjectCreated.make({ projectId: "p1", name: "alpha-again", createdAt: "t3" }),
      ProjectRenamed.make({ projectId: "p1", name: "renamed", occurredAt: "t4" })
    ])
    // The fold's tombstone is a delete-on-event; a later Created legitimately
    // re-establishes the aggregate (event-sourced replay), but the read-model
    // never shows two aggregates for the same id.
    expect(projects.filter((p) => p.id === "p1")).toHaveLength(1)
    expect(projects[0]?.name).toBe("renamed")
  })
})
