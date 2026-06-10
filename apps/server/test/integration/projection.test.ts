import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EventStore, EventStoreLayer } from "@yodea/server/db/event-store"
import { ProjectProjection, ProjectProjectionLayer } from "@yodea/server/application/projections"
import { ProjectCreated } from "@yodea/contracts/events/project"

const TestSql = SqliteClient.layer({ filename: ":memory:", disableWAL: true })

const TestLayer = Layer.provideMerge(
  ProjectProjectionLayer,
  EventStoreLayer
).pipe(Layer.provide(TestSql))

const run = <A, E>(eff: Effect.Effect<A, E, ProjectProjection | EventStore>) =>
  Effect.runPromise(Effect.provide(eff, TestLayer))

describe("ProjectProjection", () => {
  it("lists projects rebuilt from the event log", async () => {
    const projects = await run(
      Effect.gen(function* () {
        const store = yield* EventStore
        const projection = yield* ProjectProjection
        yield* store.append(
          "p1",
          ProjectCreated.make({ projectId: "p1", name: "A", occurredAt: "t1" })
        )
        return yield* projection.list
      })
    )
    expect(projects).toEqual([{ id: "p1", name: "A", directory: null, description: null, tags: [], archived: false, createdAt: "t1", updatedAt: "t1" }])
  })

  it("snapshot returns the fold plus the high-water seq (0 when empty)", async () => {
    const out = await run(
      Effect.gen(function* () {
        const store = yield* EventStore
        const projection = yield* ProjectProjection
        const empty = yield* projection.snapshot
        yield* store.append("p1", ProjectCreated.make({ projectId: "p1", name: "A", occurredAt: "t1" }))
        yield* store.append("p2", ProjectCreated.make({ projectId: "p2", name: "B", occurredAt: "t2" }))
        const full = yield* projection.snapshot
        return { empty, full }
      })
    )
    expect(out.empty).toEqual({ projects: [], seq: 0 })
    expect(out.full.seq).toBe(2)
    expect(out.full.projects.map((p) => p.name)).toEqual(["A", "B"])
  })
})
