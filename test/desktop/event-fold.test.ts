import { describe, expect, it } from "vitest"
import { ProjectCreated, ProjectDirectoryChanged, ProjectRenamed } from "@yodea/contracts/events"
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
