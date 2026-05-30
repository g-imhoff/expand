import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EventStore, EventStoreLayer } from "@yodea/db/event-store"
import { ProjectProjection, ProjectProjectionLayer } from "@yodea/application/projections"
import { ProjectCreated } from "@yodea/contracts/events"

const TestSql = SqliteClient.layer({ filename: ":memory:", disableWAL: true })

// CRITICAL: provideMerge shares ONE EventStore instance with both the test's
// append calls and the projection. Providing EventStoreLayer twice would
// build two independent :memory: databases and the projection would see nothing.
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
          ProjectCreated.make({ projectId: "p1", name: "A", createdAt: "t1" })
        )
        return yield* projection.list
      })
    )
    expect(projects).toEqual([{ id: "p1", name: "A", createdAt: "t1" }])
  })
})
