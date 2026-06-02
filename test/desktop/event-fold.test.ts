import { describe, expect, it } from "vitest"
import { ProjectCreated } from "@yodea/contracts/events"
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
})
