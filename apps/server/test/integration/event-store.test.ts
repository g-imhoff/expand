import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Cause, Effect, Layer, Pull, Stream } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { EventScanChunkSize } from "@expand/server/db/event-store"
import { ReplayFeed, ReplayFeedLayer } from "@expand/server/db/replay-feed"
import { ProjectEventStore, ProjectEventStoreLayer } from "@expand/server/application/projects/project-event-store"
import { ProjectCreated } from "@expand/contracts/events/project"
import {
  decodeStoredEventWithRegistry,
  EVENT_REVISIONS,
  EVENT_UPCASTERS
} from "@expand/server/migrations/events"
import { DatabaseReadyLayer } from "@expand/server/migrations/sqlite"

const uid = (n: number): string => "00000000-0000-4000-8000-" + String(n).padStart(12, "0")
const ev = (n: number) => ProjectCreated.make({ projectId: uid(n), name: `p${n}`, occurredAt: `t${n}` })

const TestSql = SqliteClient.layer({ filename: ":memory:", disableWAL: true })

// The raw primitives are exercised through their two specializations (ReplayFeed's
// unfiltered read + ProjectEventStore's derived append). Chunk granularity is a
// build-time Reference now — override it when building the layer.
const storeWith = (chunkSize?: number) => {
  const database = DatabaseReadyLayer.pipe(Layer.provideMerge(TestSql))
  const base = Layer.mergeAll(ReplayFeedLayer, ProjectEventStoreLayer).pipe(Layer.provideMerge(database))
  return chunkSize === undefined ? base : base.pipe(Layer.provide(Layer.succeed(EventScanChunkSize, chunkSize)))
}

const runWith = <A, E>(chunkSize: number | undefined, eff: Effect.Effect<A, E, ReplayFeed | ProjectEventStore | SqlClient>) =>
  Effect.provide(eff, storeWith(chunkSize))

const run = <A, E>(eff: Effect.Effect<A, E, ReplayFeed | ProjectEventStore | SqlClient>) => runWith(undefined, eff)

const runExit = <A, E>(eff: Effect.Effect<A, E, ReplayFeed | ProjectEventStore | SqlClient>) =>
  Effect.provide(Effect.exit(eff), storeWith(undefined))

describe("event-store base (through its specializations)", () => {
  it.live("stamps new ProjectCreated rows with revision 2", () => Effect.gen(function*() {
    const rows = yield* run(
      Effect.gen(function*() {
        const events = yield* ProjectEventStore
        const sql = yield* SqlClient
        yield* events.append(ProjectCreated.make({ projectId: uid(1), name: "alpha", directory: null, occurredAt: "t1" }))
        return yield* sql<{ readonly event_revision: number }>`SELECT event_revision FROM events`
      })
    )
    expect(rows).toEqual([{ event_revision: 2 }])
  }))

  it.live("append returns the monotonically increasing seq",  () => Effect.gen(function*() {
    const seqs = yield* run(
      Effect.gen(function* () {
        const events = yield* ProjectEventStore
        const s1 = yield* events.append(ProjectCreated.make({ projectId: uid(1), name: "alpha", occurredAt: "t1" }))
        const s2 = yield* events.append(ProjectCreated.make({ projectId: uid(2), name: "beta", occurredAt: "t2" }))
        return [s1, s2]
      })
    )
    expect(seqs).toEqual([1, 2])
  }))

  it.live("appends events and reads them back as sequenced rows in insertion order",  () => Effect.gen(function*() {
    const rows = yield* run(
      Effect.gen(function* () {
        const events = yield* ProjectEventStore
        const feed = yield* ReplayFeed
        yield* events.append(ProjectCreated.make({ projectId: uid(1), name: "alpha", occurredAt: "t1" }))
        yield* events.append(ProjectCreated.make({ projectId: uid(2), name: "beta", occurredAt: "t2" }))
        return yield* collect(feed.read(0))
      })
    )
    expect(rows.map((r) => r.seq)).toEqual([1, 2])
    expect(rows.map((r) => r.event.projectId)).toEqual([uid(1), uid(2)])
    expect(rows[0]?.event._tag).toBe("ProjectCreated")
  }))
})

describe("event-store base (through its specializations) — error paths", () => {
  it.live("upcasts a revision-1 ProjectCreated payload during replay", () => Effect.gen(function*() {
    const rows = yield* run(
      Effect.gen(function*() {
        const feed = yield* ReplayFeed
        const sql = yield* SqlClient
        yield* sql`INSERT INTO events ${sql.insert({
          stream_id: uid(1),
          event_type: "ProjectCreated",
          event_revision: 1,
          payload: `{"_tag":"ProjectCreated","projectId":"${uid(1)}","name":"alpha","occurredAt":"t1"}`
        })}`
        return yield* collect(feed.read(0))
      })
    )
    expect(rows[0]?.event).toMatchObject({ _tag: "ProjectCreated", directory: null })
  }))

  it.live("dies with row and revision context for a future event revision", () => Effect.gen(function*() {
    const exit = yield* runExit(
      Effect.gen(function*() {
        const feed = yield* ReplayFeed
        const sql = yield* SqlClient
        yield* sql`INSERT INTO events ${sql.insert({
          stream_id: uid(1),
          event_type: "ProjectCreated",
          event_revision: 3,
          payload: `{"_tag":"ProjectCreated","projectId":"${uid(1)}","name":"alpha","directory":null,"occurredAt":"t1"}`
        })}`
        return yield* collect(feed.read(0))
      })
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const message = String(Cause.squash(exit.cause))
      expect(message).toContain("seq=1")
      expect(message).toContain(`stream_id=${uid(1)}`)
      expect(message).toContain("event_type=ProjectCreated")
      expect(message).toContain("stored_revision=3")
      expect(message).toContain("target_revision=2")
    }
  }))

  it.live("reports the first missing upcaster revision", () => Effect.gen(function*() {
    const error = yield* Effect.flip(decodeStoredEventWithRegistry(
      {
        seq: 1,
        streamId: uid(1),
        eventType: "ProjectCreated",
        eventRevision: 1,
        payload: `{"_tag":"ProjectCreated","projectId":"${uid(1)}","name":"alpha","occurredAt":"t1"}`
      },
      EVENT_REVISIONS,
      { ...EVENT_UPCASTERS, ProjectCreated: {} }
    ))
    expect(error).toMatchObject({
      reason: "missing-upcaster",
      targetRevision: 2,
      failedRevision: 1
    })
  }))

  it.live("surfaces a SQL failure (defect) when the events table is missing — never silent corruption",  () => Effect.gen(function*() {
    const exit = yield* runExit(
      Effect.gen(function* () {
        const events = yield* ProjectEventStore
        const feed = yield* ReplayFeed
        const sql = yield* SqlClient
        yield* events.append(ProjectCreated.make({ projectId: uid(1), name: "alpha", occurredAt: "t1" }))
        yield* sql`DROP TABLE events`
        return yield* collect(feed.read(0))
      })
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(String(Cause.squash(exit.cause))).toMatch(/SqlError|no such table/i)
    }
  }))
})

const collect = <A, E>(s: Stream.Stream<A, E>) =>
  Stream.runCollect(s).pipe(Effect.map((c) => Array.from(c)))

describe("event-store base (through its specializations).scan", () => {
  it.live("streams an empty log as an empty stream",  () => Effect.gen(function*() {
    const out = yield* run(Effect.flatMap(ReplayFeed, (feed) => collect(feed.read(0))))
    expect(out).toEqual([])
  }))

  it.live("streams all events in seq order across chunk seams (no gap, no duplicate)",  () => Effect.gen(function*() {
    const out = yield* runWith(2,
      Effect.gen(function* () {
        const events = yield* ProjectEventStore
        const feed = yield* ReplayFeed
        for (let n = 1; n <= 5; n++) {
          yield* events.append(ProjectCreated.make({ projectId: uid(n), name: `p${n}`, occurredAt: `t${n}` }))
        }
        // chunkSize 2 forces chunks [1,2][3,4][5] — the seams are the point.
        return yield* collect(feed.read(0))
      })
    )
    expect(out.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5])
    expect(out.map((r) => r.event.projectId)).toEqual([uid(1), uid(2), uid(3), uid(4), uid(5)])
  }))

  it.live("an append landing between chunk fetches surfaces in a later chunk (no gap, no duplicate)",  () => Effect.gen(function*() {
    // Deterministic proof of the concurrent-append property of the streamed replay
    // seam. beta.74 exposes `Stream.toPull`, a pull-control primitive: each pull
    // triggers exactly ONE keyset SQL fetch (observed granularity with chunkSize 2:
    // one chunk per pull). So we can interleave an append strictly BETWEEN chunk
    // fetches and prove the new event lands in a later chunk, not lost, not doubled.
    const chunks = yield* runWith(2,
      Effect.scoped(Effect.gen(function* () {
        const events = yield* ProjectEventStore
        const feed = yield* ReplayFeed
        for (let n = 1; n <= 4; n++) yield* events.append(ev(n))
        const pull = yield* Stream.toPull(feed.read(0))
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
        yield* events.append(ev(5)) // appended AFTER the [1,2] fetch, BEFORE the after-4 fetch
        let more = true
        while (more) more = yield* pullChunk // → [3, 4], then [5] (the new event), then Done
        return got
      }))
    )
    // Property: an append during a keyset scan appears in a later chunk exactly
    // once — the new event surfaces in its own later chunk, seq order intact end to end.
    expect(chunks).toEqual([[1, 2], [3, 4], [5]])
    expect(chunks.flat()).toEqual([1, 2, 3, 4, 5])
  }))

  it.live("afterSeq is strictly exclusive",  () => Effect.gen(function*() {
    const out = yield* runWith(2,
      Effect.gen(function* () {
        const events = yield* ProjectEventStore
        const feed = yield* ReplayFeed
        yield* events.append(ProjectCreated.make({ projectId: uid(1), name: "a", occurredAt: "t1" }))
        yield* events.append(ProjectCreated.make({ projectId: uid(2), name: "b", occurredAt: "t2" }))
        yield* events.append(ProjectCreated.make({ projectId: uid(3), name: "c", occurredAt: "t3" }))
        return {
          fromZero: yield* collect(feed.read(0)),
          fromOne: yield* collect(feed.read(1)),
          fromLast: yield* collect(feed.read(3))
        }
      })
    )
    expect(out.fromZero.map((r) => r.seq)).toEqual([1, 2, 3])
    expect(out.fromOne.map((r) => r.seq)).toEqual([2, 3])
    expect(out.fromLast).toEqual([])
  }))

  it.live("dies (defect) on an undecodable row, naming seq, stream_id and event_type",  () => Effect.gen(function*() {
    const exit = yield* runExit(
      Effect.gen(function* () {
        const events = yield* ProjectEventStore
        const feed = yield* ReplayFeed
        const sql = yield* SqlClient
        yield* events.append(ProjectCreated.make({ projectId: uid(1), name: "a", occurredAt: "t1" }))
        yield* sql`INSERT INTO events ${sql.insert({ stream_id: uid(2), event_type: "ProjectCreated", payload: "{ not json" })}`
        return yield* collect(feed.read(0))
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
  }))
})
