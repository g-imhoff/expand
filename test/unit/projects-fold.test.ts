import { describe, expect, it } from "vitest"
import { projectsFromEvents } from "@yodea/domain/project"
import { ProjectCreated } from "@yodea/shared/events"

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
      { id: "p1", name: "A", createdAt: "t1" },
      { id: "p2", name: "B", createdAt: "t2" }
    ])
  })
})
