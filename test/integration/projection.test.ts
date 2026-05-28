import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EventStore, EventStoreLayer } from "@yodea/db/event-store"
import { SessionProjection, SessionProjectionLayer } from "@yodea/application/projections"
import { SessionCreated } from "@yodea/shared/events"

const TestSql = SqliteClient.layer({ filename: ":memory:", disableWAL: true })

// CRITICAL: provideMerge shares ONE EventStore instance with both the test's
// append calls and the projection. Providing EventStoreLayer twice would
// build two independent :memory: databases and the projection would see nothing.
const TestLayer = Layer.provideMerge(
  SessionProjectionLayer,
  EventStoreLayer
).pipe(Layer.provide(TestSql))

const run = <A, E>(eff: Effect.Effect<A, E, SessionProjection | EventStore>) =>
  Effect.runPromise(Effect.provide(eff, TestLayer))

describe("SessionProjection", () => {
  it("lists sessions rebuilt from the event log", async () => {
    const sessions = await run(
      Effect.gen(function* () {
        const store = yield* EventStore
        const projection = yield* SessionProjection
        yield* store.append(
          "s1",
          SessionCreated.make({ sessionId: "s1", title: "A", createdAt: "t1" })
        )
        return yield* projection.list
      })
    )
    expect(sessions).toEqual([{ id: "s1", title: "A", createdAt: "t1" }])
  })
})
