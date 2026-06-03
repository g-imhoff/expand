import { describe, expect, it } from "vitest"
import { Cause, Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EventStore, EventStoreLayer } from "@yodea/db/event-store"
import { ProjectCreated } from "@yodea/contracts/events"

const TestSql = SqliteClient.layer({ filename: ":memory:", disableWAL: true })
const TestStore = EventStoreLayer.pipe(Layer.provide(TestSql))

const run = <A, E>(eff: Effect.Effect<A, E, EventStore>) =>
  Effect.runPromise(Effect.provide(eff, TestStore))

const TestStoreWithSql = EventStoreLayer.pipe(Layer.provideMerge(TestSql))

const runResult = <A, E>(eff: Effect.Effect<A, E, EventStore | SqlClient>) =>
  Effect.runPromise(Effect.provide(Effect.result(eff), TestStoreWithSql))

const runExit = <A, E>(eff: Effect.Effect<A, E, EventStore | SqlClient>) =>
  Effect.runPromise(Effect.provide(Effect.exit(eff), TestStoreWithSql))

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

describe("EventStore — error paths", () => {
  it("fails with a SchemaError when a persisted payload is corrupt JSON", async () => {
    const r = await runResult(
      Effect.gen(function* () {
        const store = yield* EventStore
        const sql = yield* SqlClient
        yield* store.append("p1", ProjectCreated.make({ projectId: "p1", name: "A", createdAt: "t1" }))
        yield* sql`INSERT INTO events ${sql.insert({ stream_id: "p2", event_type: "ProjectCreated", payload: "{ not json" })}`
        return yield* store.readAll
      })
    )
    expect(r._tag).toBe("Failure")
    if (r._tag === "Failure") {
      expect(String(r.failure)).toMatch(/Schema|parse|JSON/i)
    }
  })

  it("surfaces a SQL failure (defect) when the events table is missing — never silent corruption", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const store = yield* EventStore
        const sql = yield* SqlClient
        yield* store.append("p1", ProjectCreated.make({ projectId: "p1", name: "A", createdAt: "t1" }))
        yield* sql`DROP TABLE events`
        return yield* store.readAll
      })
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(String(Cause.squash(exit.cause))).toMatch(/SqlError|no such table/i)
    }
  })
})
