import { describe, expect, it } from "vitest"
import { Cause, Effect, Layer, Pull, Stream } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EventStore, EventStoreLayer, EventScanChunkSize } from "@yodea/server/db/event-store"
import { ProjectCreated } from "@yodea/contracts/events/project"

const uid = (n: number): string => "00000000-0000-4000-8000-" + String(n).padStart(12, "0")
const ev = (n: number) => ProjectCreated.make({ projectId: uid(n), name: `p${n}`, occurredAt: `t${n}` })

const TestSql = SqliteClient.layer({ filename: ":memory:", disableWAL: true })

// Chunk granularity is a build-time Reference now — override it when building the layer.
const storeWith = (chunkSize?: number) => {
  const base = EventStoreLayer.pipe(Layer.provideMerge(TestSql))
  return chunkSize === undefined ? base : base.pipe(Layer.provide(Layer.succeed(EventScanChunkSize, chunkSize)))
}

const runWith = <A, E>(chunkSize: number | undefined, eff: Effect.Effect<A, E, EventStore | SqlClient>) =>
  Effect.runPromise(Effect.provide(eff, storeWith(chunkSize)))

const run = <A, E>(eff: Effect.Effect<A, E, EventStore | SqlClient>) => runWith(undefined, eff)

const runResultWith = <A, E>(chunkSize: number | undefined, eff: Effect.Effect<A, E, EventStore | SqlClient>) =>
  Effect.runPromise(Effect.provide(Effect.result(eff), storeWith(chunkSize)))

const runExit = <A, E>(eff: Effect.Effect<A, E, EventStore | SqlClient>) =>
  Effect.runPromise(Effect.provide(Effect.exit(eff), storeWith(undefined)))

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
        return yield* collect(store.scan())
      })
    )
    expect(rows.map((r) => r.seq)).toEqual([1, 2])
    expect(rows.map((r) => r.event.projectId)).toEqual([uid(1), uid(2)])
    expect(rows[0]?.event._tag).toBe("ProjectCreated")
  })
})

describe("EventStore — error paths", () => {
  it("surfaces a SQL failure (defect) when the events table is missing — never silent corruption", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const store = yield* EventStore
        const sql = yield* SqlClient
        yield* store.append(uid(1), ProjectCreated.make({ projectId: uid(1), name: "alpha", occurredAt: "t1" }))
        yield* sql`DROP TABLE events`
        return yield* collect(store.scan())
      })
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(String(Cause.squash(exit.cause))).toMatch(/SqlError|no such table/i)
    }
  })
})

const collect = <A, E>(s: Stream.Stream<A, E>) =>
  Stream.runCollect(s).pipe(Effect.map((c) => Array.from(c)))

describe("EventStore.scan", () => {
  it("streams an empty log as an empty stream", async () => {
    const out = await run(Effect.flatMap(EventStore, (s) => collect(s.scan())))
    expect(out).toEqual([])
  })

  it("streams all events in seq order across chunk seams (no gap, no duplicate)", async () => {
    const out = await runWith(2,
      Effect.gen(function* () {
        const store = yield* EventStore
        for (let n = 1; n <= 5; n++) {
          yield* store.append(uid(n), ProjectCreated.make({ projectId: uid(n), name: `p${n}`, occurredAt: `t${n}` }))
        }
        // chunkSize 2 forces chunks [1,2][3,4][5] — the seams are the point.
        return yield* collect(store.scan())
      })
    )
    expect(out.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5])
    expect(out.map((r) => r.event.projectId)).toEqual([uid(1), uid(2), uid(3), uid(4), uid(5)])
  })

  it("an append landing between chunk fetches surfaces in a later chunk (no gap, no duplicate)", async () => {
    // Deterministic proof of the concurrent-append property of the streamed replay
    // seam. beta.74 exposes `Stream.toPull`, a pull-control primitive: each pull
    // triggers exactly ONE keyset SQL fetch (observed granularity with chunkSize 2:
    // one chunk per pull). So we can interleave an append strictly BETWEEN chunk
    // fetches and prove the new event lands in a later chunk, not lost, not doubled.
    const chunks = await runWith(2,
      Effect.scoped(Effect.gen(function* () {
        const store = yield* EventStore
        for (let n = 1; n <= 4; n++) yield* store.append(uid(n), ev(n))
        const pull = yield* Stream.toPull(store.scan({ afterSeq: 0 }))
        const got: Array<Array<number>> = []
        const pullChunk = pull.pipe(
          Effect.map((chunk) => {
            got.push(chunk.map((se) => se.seq))
            return true
          }),
          Pull.catchDone(() => Effect.succeed(false)),
          Effect.orDie
        )
        yield* pullChunk // first fetch → [1, 2]
        yield* store.append(uid(5), ev(5)) // appended AFTER the [1,2] fetch, BEFORE the after-4 fetch
        let more = true
        while (more) more = yield* pullChunk // → [3, 4], then [5] (the new event), then Done
        return got
      }))
    )
    // Property: an append during a keyset scan appears in a later chunk exactly
    // once — the new event surfaces in its own later chunk, seq order intact end to end.
    expect(chunks).toEqual([[1, 2], [3, 4], [5]])
    expect(chunks.flat()).toEqual([1, 2, 3, 4, 5])
  })

  it("afterSeq is strictly exclusive", async () => {
    const out = await runWith(2,
      Effect.gen(function* () {
        const store = yield* EventStore
        yield* store.append(uid(1), ProjectCreated.make({ projectId: uid(1), name: "a", occurredAt: "t1" }))
        yield* store.append(uid(2), ProjectCreated.make({ projectId: uid(2), name: "b", occurredAt: "t2" }))
        yield* store.append(uid(3), ProjectCreated.make({ projectId: uid(3), name: "c", occurredAt: "t3" }))
        return {
          fromZero: yield* collect(store.scan({ afterSeq: 0 })),
          fromOne: yield* collect(store.scan({ afterSeq: 1 })),
          fromLast: yield* collect(store.scan({ afterSeq: 3 }))
        }
      })
    )
    expect(out.fromZero.map((r) => r.seq)).toEqual([1, 2, 3])
    expect(out.fromOne.map((r) => r.seq)).toEqual([2, 3])
    expect(out.fromLast).toEqual([])
  })

  it("eventTypes filters at the SQL level (foreign rows never reach the decoder)", async () => {
    const out = await runResultWith(1,
      Effect.gen(function* () {
        const store = yield* EventStore
        const sql = yield* SqlClient
        yield* store.append(uid(1), ProjectCreated.make({ projectId: uid(1), name: "a", occurredAt: "t1" }))
        // A foreign family's row with a payload our union can NOT decode: with the
        // filter it must be excluded in SQL, so no decode (and no defect) happens.
        yield* sql`INSERT INTO events ${sql.insert({ stream_id: uid(9), event_type: "SomethingElse", payload: "{\"_tag\":\"SomethingElse\"}" })}`
        yield* store.append(uid(2), ProjectCreated.make({ projectId: uid(2), name: "b", occurredAt: "t2" }))
        return yield* collect(store.scan({ eventTypes: ["ProjectCreated"] }))
      })
    )
    expect(out._tag).toBe("Success")
    if (out._tag === "Success") expect(out.success.map((r) => r.seq)).toEqual([1, 3])
  })

  it("dies (defect) on an undecodable row, naming seq, stream_id and event_type", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const store = yield* EventStore
        const sql = yield* SqlClient
        yield* store.append(uid(1), ProjectCreated.make({ projectId: uid(1), name: "a", occurredAt: "t1" }))
        yield* sql`INSERT INTO events ${sql.insert({ stream_id: uid(2), event_type: "ProjectCreated", payload: "{ not json" })}`
        return yield* collect(store.scan())
      })
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const msg = String(Cause.squash(exit.cause))
      expect(msg).toMatch(/undecodable event row/)
      expect(msg).toContain("seq=2")
      expect(msg).toContain(`stream_id=${uid(2)}`)
      expect(msg).toContain("event_type=ProjectCreated")
    }
  })
})
