import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EventStore, EventStoreLayer } from "@yodea/db/event-store"
import { ProjectCreated } from "@yodea/shared/events"

// In-memory DB, WAL disabled (WAL is meaningless / noisy for :memory:).
const TestSql = SqliteClient.layer({ filename: ":memory:", disableWAL: true })
const TestStore = EventStoreLayer.pipe(Layer.provide(TestSql))

const run = <A, E>(eff: Effect.Effect<A, E, EventStore>) =>
  Effect.runPromise(Effect.provide(eff, TestStore))

describe("EventStore", () => {
  it("appends events and reads them back in insertion order", async () => {
    const events = await run(
      Effect.gen(function* () {
        const store = yield* EventStore
        yield* store.append(
          "p1",
          ProjectCreated.make({ projectId: "p1", name: "A", createdAt: "t1" })
        )
        yield* store.append(
          "p2",
          ProjectCreated.make({ projectId: "p2", name: "B", createdAt: "t2" })
        )
        return yield* store.readAll
      })
    )
    expect(events.map((e) => e.projectId)).toEqual(["p1", "p2"])
    expect(events[0]?._tag).toBe("ProjectCreated")
  })

  it("returns an empty log initially", async () => {
    const events = await run(Effect.flatMap(EventStore, (s) => s.readAll))
    expect(events).toEqual([])
  })
})
