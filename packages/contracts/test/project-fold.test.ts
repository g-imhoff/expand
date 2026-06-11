import { describe, expect, it } from "vitest"
import { Project } from "@yodea/contracts/project"
import {
  ProjectArchived, ProjectCreated, ProjectDeleted, ProjectDirectoryChanged,
  ProjectMetadataChanged, ProjectRenamed, ProjectRestored
} from "@yodea/contracts/events/project"
import { ProjectId, ProjectName, Tag } from "@yodea/contracts/project"

const uid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const created = ProjectCreated.make({ projectId: ProjectId.make(uid(1)), name: ProjectName.make("alpha"), directory: null, occurredAt: "t1" })

describe("Project.fromCreated", () => {
  it("builds the full read model from a create event", () => {
    expect(Project.fromCreated(created)).toEqual({
      id: uid(1), name: "alpha", directory: null, description: null,
      tags: [], archived: false, createdAt: "t1", updatedAt: "t1"
    })
  })
})

describe("Project.applyEvent", () => {
  const base = Project.fromCreated(created)
  it("rename updates name and updatedAt", () => {
    const p = Project.applyEvent(base, ProjectRenamed.make({ projectId: ProjectId.make(uid(1)), name: ProjectName.make("alpha-2"), occurredAt: "t2" }))
    expect(p.name).toBe("alpha-2")
    expect(p.updatedAt).toBe("t2")
    expect(p.createdAt).toBe("t1")
  })
  it("directory change, archive, restore", () => {
    const moved = Project.applyEvent(base, ProjectDirectoryChanged.make({ projectId: ProjectId.make(uid(1)), directory: "/tmp", occurredAt: "t2" }))
    expect(moved.directory).toBe("/tmp")
    const archived = Project.applyEvent(base, ProjectArchived.make({ projectId: ProjectId.make(uid(1)), occurredAt: "t3" }))
    expect(archived.archived).toBe(true)
    const restored = Project.applyEvent(archived, ProjectRestored.make({ projectId: ProjectId.make(uid(1)), occurredAt: "t4" }))
    expect(restored.archived).toBe(false)
  })
  it("metadata patch is partial and dedupes tags", () => {
    const p = Project.applyEvent(base, ProjectMetadataChanged.make({ projectId: ProjectId.make(uid(1)), tags: [Tag.make("x"), Tag.make("x"), Tag.make("y")] as ReadonlyArray<Tag>, occurredAt: "t2" }))
    expect(p.tags).toEqual(["x", "y"])
    expect(p.description).toBeNull()
  })
})

describe("Project.foldList", () => {
  it("create appends once (idempotent), delete removes, unknown ids are no-ops", () => {
    const one = Project.foldList([], created)
    expect(Project.foldList(one, created)).toHaveLength(1)
    expect(Project.foldList(one, ProjectRenamed.make({ projectId: ProjectId.make(uid(9)), name: ProjectName.make("ghost"), occurredAt: "t9" }))).toEqual(one)
    expect(Project.foldList(one, ProjectDeleted.make({ projectId: ProjectId.make(uid(1)), occurredAt: "t9" }))).toEqual([])
  })
})
