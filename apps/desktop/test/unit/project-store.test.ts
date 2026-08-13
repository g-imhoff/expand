import { it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"
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

  it.effect("publishes projects and seq atomically", () =>
    Effect.gen(function* () {
      const store = makeProjectsStore()
      yield* makeProjectSyncSink(store).snapshot({ projects: [alpha], seq: 7 })
      expect(store.getState()).toMatchObject({ projects: [alpha], seq: 7 })
    }))
})
