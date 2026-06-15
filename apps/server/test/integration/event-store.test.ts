import { describe, expect, it } from "vitest"
import { Cause, Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EventStore, EventStoreLayer } from "@yodea/server/db/event-store"
import { ProjectCreated } from "@yodea/contracts/events/project"

const uid = (n: number): string => "00000000-0000-4000-8000-" + String(n).padStart(12, "0")

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
  it("append returns the monotonically increasing seq", async () => {
    const seqs = await run(
      Effect.gen(function* () {
        const store = yield* EventStore
        const s1 = yield* store.append(uid(1), ProjectCreated.make({ projectId: uid(1), name: "alpha", occurredAt: "t1" }))
        const s2 = yield* store.append(uid(2), ProjectCreated.make({ projectId: uid(2), name: "beta", occurredAt: "t2" }))
        return [s1, s2]
      })
    )
    expect(seqs).toEqual([1, 2])
  })

  it("appends events and reads them back as sequenced rows in insertion order", async () => {
    const rows = await run(
      Effect.gen(function* () {
        const store = yield* EventStore
        yield* store.append(uid(1), ProjectCreated.make({ projectId: uid(1), name: "alpha", occurredAt: "t1" }))
        yield* store.append(uid(2), ProjectCreated.make({ projectId: uid(2), name: "beta", occurredAt: "t2" }))
        return yield* store.readAll
      })
    )
    expect(rows.map((r) => r.seq)).toEqual([1, 2])
    expect(rows.map((r) => r.event.projectId)).toEqual([uid(1), uid(2)])
    expect(rows[0]?.event._tag).toBe("ProjectCreated")
  })

  it("returns an empty log initially", async () => {
    const rows = await run(Effect.flatMap(EventStore, (s) => s.readAll))
    expect(rows).toEqual([])
  })

  it("readFrom returns only rows strictly after the cursor", async () => {
    const out = await run(
      Effect.gen(function* () {
        const store = yield* EventStore
        yield* store.append(uid(1), ProjectCreated.make({ projectId: uid(1), name: "alpha", occurredAt: "t1" }))
        yield* store.append(uid(2), ProjectCreated.make({ projectId: uid(2), name: "beta", occurredAt: "t2" }))
        yield* store.append(uid(3), ProjectCreated.make({ projectId: uid(3), name: "gamma", occurredAt: "t3" }))
        return {
          fromZero: yield* store.readFrom(0),
          fromOne: yield* store.readFrom(1),
          fromLast: yield* store.readFrom(3)
        }
      })
    )
    expect(out.fromZero.map((r) => r.seq)).toEqual([1, 2, 3])
    expect(out.fromOne.map((r) => r.seq)).toEqual([2, 3])
    expect(out.fromLast).toEqual([])
  })
})

describe("EventStore — error paths", () => {
  it("skips a corrupt-JSON payload row and returns the remaining sequenced events", async () => {
    const r = await runResult(
      Effect.gen(function* () {
        const store = yield* EventStore
        const sql = yield* SqlClient
        yield* store.append(uid(1), ProjectCreated.make({ projectId: uid(1), name: "alpha", occurredAt: "t1" }))
        yield* sql`INSERT INTO events ${sql.insert({ stream_id: uid(2), event_type: "ProjectCreated", payload: "{ not json" })}`
        return yield* store.readAll
      })
    )
    expect(r._tag).toBe("Success")
    if (r._tag === "Success") {
      expect(r.success.map((x) => x.event.projectId)).toEqual([uid(1)])
      expect(r.success.map((x) => x.seq)).toEqual([1])
    }
  })

  it("surfaces a SQL failure (defect) when the events table is missing — never silent corruption", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const store = yield* EventStore
        const sql = yield* SqlClient
        yield* store.append(uid(1), ProjectCreated.make({ projectId: uid(1), name: "alpha", occurredAt: "t1" }))
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
