import { describe, expect, it } from "vitest"
import { Cause, Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EventStore, EventStoreLayer } from "@yodea/db/event-store"
import { ProjectCreated } from "@yodea/contracts/events"

// In-memory DB, WAL disabled (WAL is meaningless / noisy for :memory:).
const TestSql = SqliteClient.layer({ filename: ":memory:", disableWAL: true })
const TestStore = EventStoreLayer.pipe(Layer.provide(TestSql))

const run = <A, E>(eff: Effect.Effect<A, E, EventStore>) =>
  Effect.runPromise(Effect.provide(eff, TestStore))

// For the error-path tests we need both the EventStore AND the raw SqlClient in
// scope, backed by the SAME :memory: connection — so the store and the injected
// corruption/DROP hit one database. `provideMerge` feeds one TestSql into the
// store layer AND re-exports SqlClient, so both resolve from the same client.
const TestStoreWithSql = EventStoreLayer.pipe(Layer.provideMerge(TestSql))

const runResult = <A, E>(eff: Effect.Effect<A, E, EventStore | SqlClient>) =>
  Effect.runPromise(Effect.provide(Effect.result(eff), TestStoreWithSql))

// Run to a full Exit so we can inspect defects too — the bun:sqlite driver
// throws "no such table" at statement *prepare* time, which is outside the
// driver's try/catch, so a missing-table read surfaces as a DEFECT (die) rather
// than a typed SqlError that Effect.result would capture.
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
        // create the table + a good row, then inject a corrupt one directly.
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
    // The store declares `SqlError`, but the bun:sqlite driver prepares the
    // statement (`db.query(sql)`) BEFORE its try/catch, so a "no such table"
    // failure escapes as a thrown SQLiteError -> an Effect DEFECT, not a typed
    // failure. The contract we certify is "never silent corruption": the read
    // does NOT succeed with stale/garbage rows — it crashes loudly.
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
