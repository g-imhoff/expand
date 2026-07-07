import { describe, expect, it } from "vitest"
import { Project } from "@yodea/contracts/project"
import type { DomainEvent } from "@yodea/contracts/events/domain"
import { ProjectArchived, ProjectCreated, ProjectDeleted, ProjectDirectoryChanged, ProjectMetadataChanged, ProjectRenamed, ProjectRestored } from "@yodea/contracts/events/project"

const foldAll = (events: ReadonlyArray<DomainEvent>): ReadonlyArray<Project> =>
  events.reduce<ReadonlyArray<Project>>((acc, e) => Project.foldList(acc, e), [])

const uid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const pid = (n: number): string => uid(n)
const pn = (s: string): string => s
const tag = (s: string): string => s

describe("Project.foldList", () => {
  it("folds an empty log into no projects", () => {
    expect(foldAll([])).toEqual([])
  })

  it("folds ProjectCreated events into the read-model", () => {
    const projects = foldAll([
      ProjectCreated.make({ projectId: pid(1), name: pn("a"), occurredAt: "t1" }),
      ProjectCreated.make({ projectId: pid(2), name: pn("b"), occurredAt: "t2" })
    ])
    expect(projects).toEqual([
      { id: uid(1), name: "a", directory: null, description: null, tags: [], archived: false, createdAt: "t1", updatedAt: "t1" },
      { id: uid(2), name: "b", directory: null, description: null, tags: [], archived: false, createdAt: "t2", updatedAt: "t2" }
    ])
  })

  it("ProjectRenamed updates name and stamps updatedAt from occurredAt", () => {
    const projects = foldAll([
      ProjectCreated.make({ projectId: pid(1), name: pn("a"), directory: null, occurredAt: "t1" }),
      ProjectRenamed.make({ projectId: pid(1), name: pn("a2"), occurredAt: "t2" })
    ])
    expect(projects).toEqual([
      { id: uid(1), name: "a2", directory: null, description: null, tags: [], archived: false, createdAt: "t1", updatedAt: "t2" }
    ])
  })

  it("ProjectRenamed with no prior Created is a no-op (out-of-order tolerance)", () => {
    expect(foldAll([ProjectRenamed.make({ projectId: pid(9), name: pn("x"), occurredAt: "t9" })])).toEqual([])
  })

  it("ProjectDirectoryChanged sets directory + updatedAt on an existing project", () => {
    const projects = foldAll([
      ProjectCreated.make({ projectId: pid(1), name: pn("a"), directory: null, occurredAt: "t1" }),
      ProjectDirectoryChanged.make({ projectId: pid(1), directory: "/srv/p1", occurredAt: "t2" })
    ])
    expect(projects).toEqual([
      { id: uid(1), name: "a", directory: "/srv/p1", description: null, tags: [], archived: false, createdAt: "t1", updatedAt: "t2" }
    ])
  })

  it("ProjectDirectoryChanged for an unknown id is a no-op", () => {
    expect(foldAll([
      ProjectDirectoryChanged.make({ projectId: pid(9), directory: "/srv/x", occurredAt: "t9" })
    ])).toEqual([])
  })
})

describe("Project.foldList — archive/restore", () => {
  it("ProjectArchived sets archived:true and stamps updatedAt", () => {
    const [p] = foldAll([
      ProjectCreated.make({ projectId: pid(1), name: pn("a"), occurredAt: "t1" }),
      ProjectArchived.make({ projectId: pid(1), occurredAt: "t2" })
    ])
    expect(p?.archived).toBe(true)
    expect(p?.updatedAt).toBe("t2")
    expect(p?.createdAt).toBe("t1")
  })
  it("ProjectRestored sets archived:false and stamps updatedAt", () => {
    const [p] = foldAll([
      ProjectCreated.make({ projectId: pid(1), name: pn("a"), occurredAt: "t1" }),
      ProjectArchived.make({ projectId: pid(1), occurredAt: "t2" }),
      ProjectRestored.make({ projectId: pid(1), occurredAt: "t3" })
    ])
    expect(p?.archived).toBe(false)
    expect(p?.updatedAt).toBe("t3")
  })
  it("ignores an archive for an unknown project (out-of-order tolerance)", () => {
    expect(foldAll([ProjectArchived.make({ projectId: pid(9), occurredAt: "t1" })])).toEqual([])
  })
})

describe("Project.foldList — ProjectMetadataChanged", () => {
  const created = ProjectCreated.make({ projectId: pid(1), name: pn("a"), occurredAt: "t1" })

  it("merges only provided fields and stamps updatedAt from occurredAt", () => {
    const projects = foldAll([
      created,
      ProjectMetadataChanged.make({ projectId: pid(1), description: "hello", occurredAt: "t2" })
    ])
    expect(projects).toEqual([
      { id: uid(1), name: "a", directory: null, description: "hello", tags: [], archived: false, createdAt: "t1", updatedAt: "t2" }
    ])
  })

  it("dedupes tags and leaves description unchanged when absent", () => {
    const projects = foldAll([
      created,
      ProjectMetadataChanged.make({ projectId: pid(1), tags: [tag("x"), tag("x"), tag("y")], occurredAt: "t3" })
    ])
    expect(projects[0]?.tags).toEqual(["x", "y"])
    expect(projects[0]?.description).toBe(null)
    expect(projects[0]?.updatedAt).toBe("t3")
  })

  it("sets description to null when description:null is provided", () => {
    const projects = foldAll([
      ProjectCreated.make({ projectId: pid(1), name: pn("a"), occurredAt: "t1" }),
      ProjectMetadataChanged.make({ projectId: pid(1), description: "x", occurredAt: "t2" }),
      ProjectMetadataChanged.make({ projectId: pid(1), description: null, occurredAt: "t3" })
    ])
    expect(projects[0]?.description).toBe(null)
  })

  it("is a no-op for an unknown project id (out-of-order tolerance)", () => {
    const projects = foldAll([
      ProjectMetadataChanged.make({ projectId: pid(9), tags: [tag("x")], occurredAt: "t2" })
    ])
    expect(projects).toEqual([])
  })
})

describe("Project.foldList — ProjectDeleted", () => {
  it("removes a project from the read-model (tombstone)", () => {
    const projects = foldAll([
      ProjectCreated.make({ projectId: pid(1), name: pn("a"), occurredAt: "t1" }),
      ProjectCreated.make({ projectId: pid(2), name: pn("b"), occurredAt: "t2" }),
      ProjectDeleted.make({ projectId: pid(1), occurredAt: "t3" })
    ])
    expect(projects.map((p) => p.id)).toEqual([uid(2)])
  })
  it("a delete with no prior Created is a no-op (out-of-order tolerance)", () => {
    expect(foldAll([ProjectDeleted.make({ projectId: pid(9), occurredAt: "t1" })])).toEqual([])
  })
})

describe("Project.foldList — out-of-order & duplicate tolerance", () => {
  it("ignores a mutation that arrives before its ProjectCreated (no prior aggregate)", () => {
    const projects = foldAll([
      ProjectRenamed.make({ projectId: pid(9), name: pn("renamed"), occurredAt: "t2" })
    ])
    expect(projects).toEqual([])
  })

  it("drops on ProjectDeleted and a later mutation for the tombstoned id is a no-op", () => {
    const projects = foldAll([
      ProjectCreated.make({ projectId: pid(1), name: pn("a"), occurredAt: "t1" }),
      ProjectDeleted.make({ projectId: pid(1), occurredAt: "t2" }),
      ProjectRenamed.make({ projectId: pid(1), name: pn("b"), occurredAt: "t3" })
    ])
    expect(projects).toEqual([])
  })

  it("stamps updatedAt from each event's time and keeps createdAt fixed", () => {
    const [p] = foldAll([
      ProjectCreated.make({ projectId: pid(1), name: pn("a"), occurredAt: "t1" }),
      ProjectRenamed.make({ projectId: pid(1), name: pn("b"), occurredAt: "t5" })
    ])
    expect(p).toMatchObject({ id: uid(1), name: "b", createdAt: "t1", updatedAt: "t5" })
  })

  it("ProjectCreated without a directory folds directory to null (event-versioning)", () => {
    const [p] = foldAll([
      ProjectCreated.make({ projectId: pid(1), name: pn("a"), occurredAt: "t1" })
    ])
    expect(p?.directory).toBeNull()
  })

  it("metadata is replace-style per field and dedupes tags", () => {
    const [p] = foldAll([
      ProjectCreated.make({ projectId: pid(1), name: pn("a"), occurredAt: "t1" }),
      ProjectMetadataChanged.make({ projectId: pid(1), description: "first", tags: [tag("x"), tag("x"), tag("y")], occurredAt: "t2" }),
      ProjectMetadataChanged.make({ projectId: pid(1), tags: [tag("z")], occurredAt: "t3" })
    ])
    expect(p).toMatchObject({ description: "first", tags: ["z"], updatedAt: "t3" })
  })

  it("archive then restore toggles archived back to false", () => {
    const [p] = foldAll([
      ProjectCreated.make({ projectId: pid(1), name: pn("a"), occurredAt: "t1" }),
      ProjectArchived.make({ projectId: pid(1), occurredAt: "t2" }),
      ProjectRestored.make({ projectId: pid(1), occurredAt: "t3" })
    ])
    expect(p?.archived).toBe(false)
  })

  it("a duplicate ProjectCreated for the same id does not duplicate or reset the aggregate", () => {
    const projects = foldAll([
      ProjectCreated.make({ projectId: pid(1), name: pn("b"), occurredAt: "t1" }),
      ProjectRenamed.make({ projectId: pid(1), name: pn("renamed"), occurredAt: "t5" }),
      ProjectCreated.make({ projectId: pid(1), name: pn("c"), occurredAt: "t9" })
    ])
    expect(projects).toHaveLength(1)
    // first-create-wins: name stays "renamed" (the interleaved rename survives the late duplicate create)
    expect(projects[0]?.name).toBe("renamed")
    // timestamps: createdAt fixed to first create; updatedAt fixed to last real mutation
    expect(projects[0]?.createdAt).toBe("t1")
    expect(projects[0]?.updatedAt).toBe("t5")
  })

  it("directory-changed updates directory and stamps updatedAt", () => {
    const [p] = foldAll([
      ProjectCreated.make({ projectId: pid(1), name: pn("a"), occurredAt: "t1" }),
      ProjectDirectoryChanged.make({ projectId: pid(1), directory: "/tmp/x", occurredAt: "t2" })
    ])
    expect(p).toMatchObject({ directory: "/tmp/x", updatedAt: "t2" })
  })

  it("folds a full realistic lifecycle: create -> rename -> change-dir -> archive -> restore -> set-metadata", () => {
    const [p] = foldAll([
      ProjectCreated.make({ projectId: pid(1), name: pn("alpha"), occurredAt: "t1" }),
      ProjectRenamed.make({ projectId: pid(1), name: pn("beta"), occurredAt: "t2" }),
      ProjectDirectoryChanged.make({ projectId: pid(1), directory: "/srv/beta", occurredAt: "t3" }),
      ProjectArchived.make({ projectId: pid(1), occurredAt: "t4" }),
      ProjectRestored.make({ projectId: pid(1), occurredAt: "t5" }),
      ProjectMetadataChanged.make({ projectId: pid(1), description: "the beta project", tags: [tag("x"), tag("y")], occurredAt: "t6" })
    ])
    expect(p).toEqual({
      id: uid(1),
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
    const projects = foldAll([
      ProjectCreated.make({ projectId: pid(1), name: pn("alpha"), occurredAt: "t1" }),
      ProjectDeleted.make({ projectId: pid(1), occurredAt: "t2" }),
      ProjectCreated.make({ projectId: pid(1), name: pn("alpha"), occurredAt: "t3" }),
      ProjectRenamed.make({ projectId: pid(1), name: pn("renamed"), occurredAt: "t4" })
    ])
    expect(projects.filter((p) => p.id === uid(1))).toHaveLength(1)
    expect(projects[0]?.name).toBe("renamed")
  })
})
