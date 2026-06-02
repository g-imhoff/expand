import { describe, expect, it } from "vitest"
import { ProjectArchived, ProjectCreated, ProjectDirectoryChanged, ProjectMetadataChanged, ProjectRenamed, ProjectRestored } from "@yodea/contracts/events"
import { foldEvent } from "@yodea/desktop/renderer/features/projects/event-fold"

describe("foldEvent", () => {
  it("appends a ProjectCreated to the list with the full read-model shape", () => {
    const next = foldEvent([], ProjectCreated.make({ projectId: "a", name: "alpha", createdAt: "t" }))
    expect(next).toEqual([
      { id: "a", name: "alpha", directory: null, description: null, tags: [], archived: false, createdAt: "t", updatedAt: "t" }
    ])
  })
  it("is idempotent on project id (no duplicates)", () => {
    const base = [{ id: "a", name: "alpha", directory: null, description: null, tags: [], archived: false, createdAt: "t", updatedAt: "t" }]
    const next = foldEvent(base, ProjectCreated.make({ projectId: "a", name: "alpha", createdAt: "t" }))
    expect(next).toHaveLength(1)
  })
  it("ProjectRenamed updates the matching project name in place", () => {
    const base = foldEvent([], ProjectCreated.make({ projectId: "a", name: "alpha", directory: null, createdAt: "t" }))
    const next = foldEvent(base, ProjectRenamed.make({ projectId: "a", name: "alpha-2", occurredAt: "t2" }))
    expect(next.map((p) => p.name)).toEqual(["alpha-2"])
    expect(next.find((p) => p.id === "a")?.updatedAt).toBe("t2")
  })
  it("ProjectRenamed for an unknown id is a no-op", () => {
    expect(foldEvent([], ProjectRenamed.make({ projectId: "ghost", name: "x", occurredAt: "t" }))).toEqual([])
  })
  it("ProjectDirectoryChanged updates directory + updatedAt", () => {
    const base = [{ id: "a", name: "alpha", directory: null, description: null, tags: [], archived: false, createdAt: "t1", updatedAt: "t1" }]
    const next = foldEvent(base, ProjectDirectoryChanged.make({ projectId: "a", directory: "/srv/a", occurredAt: "t2" }))
    expect(next[0]?.directory).toBe("/srv/a")
    expect(next[0]?.updatedAt).toBe("t2")
  })
  it("ProjectDirectoryChanged for an unknown id is a no-op", () => {
    const base = [{ id: "a", name: "alpha", directory: null, description: null, tags: [], archived: false, createdAt: "t1", updatedAt: "t1" }]
    expect(foldEvent(base, ProjectDirectoryChanged.make({ projectId: "z", directory: "/x", occurredAt: "t2" }))).toEqual(base)
  })
})

describe("foldEvent — archive/restore", () => {
  it("sets archived:true on ProjectArchived and stamps updatedAt", () => {
    const base = [{ id: "a", name: "alpha", directory: null, description: null, tags: [], archived: false, createdAt: "t1", updatedAt: "t1" }]
    const next = foldEvent(base, ProjectArchived.make({ projectId: "a", occurredAt: "t2" }))
    expect(next[0]?.archived).toBe(true)
    expect(next[0]?.updatedAt).toBe("t2")
  })
  it("sets archived:false on ProjectRestored", () => {
    const base = [{ id: "a", name: "alpha", directory: null, description: null, tags: [], archived: true, createdAt: "t1", updatedAt: "t2" }]
    const next = foldEvent(base, ProjectRestored.make({ projectId: "a", occurredAt: "t3" }))
    expect(next[0]?.archived).toBe(false)
    expect(next[0]?.updatedAt).toBe("t3")
  })
})


describe("foldEvent — ProjectMetadataChanged", () => {
  const base = [{ id: "a", name: "alpha", directory: null, description: null, tags: [], archived: false, createdAt: "t", updatedAt: "t" }]
  it("merges provided fields and stamps updatedAt", () => {
    const next = foldEvent(base, ProjectMetadataChanged.make({ projectId: "a", description: "d", tags: ["x", "x"], occurredAt: "t2" }))
    expect(next[0]).toMatchObject({ description: "d", tags: ["x"], updatedAt: "t2" })
  })
  it("is a no-op for an unknown id", () => {
    const next = foldEvent(base, ProjectMetadataChanged.make({ projectId: "ghost", tags: ["x"], occurredAt: "t2" }))
    expect(next).toEqual(base)
  })
})
