import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { Project } from "@expand/contracts/project"
import { makeProjectSyncSink, makeProjectsStore } from "@expand/desktop/renderer/features/projects/data/project-store"

const alpha = Schema.decodeUnknownSync(Project)({
  id: "00000000-0000-4000-8000-000000000001",
  name: "alpha",
  directory: null,
  description: null,
  tags: [],
  archived: false,
  createdAt: "t",
  updatedAt: "t"
})

describe("ProjectsStore", () => {
  it("creates independent stores for renderer boots", () => {
    const first = makeProjectsStore()
    const second = makeProjectsStore()
    first.setState({ projects: [alpha], seq: 1 })
    expect(second.getState()).toEqual({
      projects: [],
      seq: 0,
      status: "disconnected"
    })
  })

  it("publishes projects and seq atomically", () => {
    const store = makeProjectsStore()
    makeProjectSyncSink(store).snapshot({ projects: [alpha], seq: 7 })
    expect(store.getState()).toMatchObject({ projects: [alpha], seq: 7 })
  })
})
