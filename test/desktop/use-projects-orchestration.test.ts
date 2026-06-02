import { describe, expect, it } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { ProjectCreated } from "@yodea/contracts/events"
import type { Project } from "@yodea/contracts/project"
import { PROJECTS_KEY, applyEventToCache } from "@yodea/desktop/renderer/features/projects/cache"

describe("projects cache orchestration", () => {
  it("applyEventToCache folds a ProjectCreated into the projects query", () => {
    const qc = new QueryClient()
    qc.setQueryData<ReadonlyArray<Project>>(PROJECTS_KEY, [])
    applyEventToCache(qc, ProjectCreated.make({ projectId: "a", name: "alpha", createdAt: "t" }))
    expect(qc.getQueryData<ReadonlyArray<Project>>(PROJECTS_KEY)?.map((p) => p.name)).toEqual(["alpha"])
  })
  it("applyEventToCache is idempotent on id", () => {
    const qc = new QueryClient()
    qc.setQueryData<ReadonlyArray<Project>>(PROJECTS_KEY, [{ id: "a", name: "alpha", directory: null, description: null, tags: [], archived: false, createdAt: "t", updatedAt: "t" }])
    applyEventToCache(qc, ProjectCreated.make({ projectId: "a", name: "alpha", createdAt: "t" }))
    expect(qc.getQueryData<ReadonlyArray<Project>>(PROJECTS_KEY)).toHaveLength(1)
  })
})
