import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Cause, Effect, Exit, Layer, Stream } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { ReplayFeed, ReplayFeedLayer } from "@expand/server/db/replay-feed"
import { ProjectEventStore, ProjectEventStoreLayer } from "@expand/server/application/projects/project-event-store"
import { ProjectCreated } from "@expand/contracts/events/project"
import { DatabaseReadyLayer } from "@expand/server/migrations/sqlite"
import { StoredEventMigrationError } from "@expand/server/migrations/events"

const uid = (n: number): string => "00000000-0000-4000-8000-" + String(n).padStart(12, "0")
const ev = (n: number) => ProjectCreated.make({ projectId: uid(n), name: `p${n}`, occurredAt: `t${n}` })

const TestSql = SqliteClient.layer({ filename: ":memory:", disableWAL: true })
const TestDatabase = DatabaseReadyLayer.pipe(Layer.provideMerge(TestSql))
const TestLayer = Layer.mergeAll(ReplayFeedLayer, ProjectEventStoreLayer).pipe(Layer.provideMerge(TestDatabase))

const run = <A, E>(eff: Effect.Effect<A, E, ReplayFeed | ProjectEventStore | SqlClient>) =>
  Effect.provide(eff, TestLayer)

const collect = <A, E>(s: Stream.Stream<A, E>) =>
  Stream.runCollect(s).pipe(Effect.map((c) => Array.from(c)))

describe("ReplayFeed", () => {
  it.live("reads the whole log strictly after the cursor, in seq order",  () => Effect.gen(function*() {
    const out = yield* run(
      Effect.gen(function* () {
        const events = yield* ProjectEventStore
        const feed = yield* ReplayFeed
        for (let n = 1; n <= 3; n++) yield* events.append(ev(n))
        return { all: yield* collect(feed.read(0)), after: yield* collect(feed.read(1)) }
      })
    )
    expect(out.all.map((se) => se.seq)).toEqual([1, 2, 3])
    expect(out.after.map((se) => se.seq)).toEqual([2, 3])
  }))

  it.live("is unfiltered: a foreign undecodable row is a defect, not silently skipped",  () => Effect.gen(function*() {
    // The deliberate contrast with ProjectEventStore.read (which excludes foreign
    // rows in SQL): the sync feed serves EVERYTHING, so a bad row must die loudly.
    const exit = yield* (Effect.provide(
      Effect.exit(Effect.gen(function* () {
        const events = yield* ProjectEventStore
        const feed = yield* ReplayFeed
        const sql = yield* SqlClient
        yield* events.append(ev(1))
        yield* sql`INSERT INTO events ${sql.insert({ stream_id: uid(9), event_type: "SomethingElse", payload: "{\"whatever\":true}" })}`
        return yield* collect(feed.read(0))
      })),
      TestLayer
    ))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(String(Cause.squash(exit.cause))).toMatch(/undecodable event row/)
    }
  }))

  it.live("preserves stored-event migration diagnostics as the replay defect", () => Effect.gen(function*() {
    const exit = yield* Effect.provide(
      Effect.gen(function*() {
        const feed = yield* ReplayFeed
        const sql = yield* SqlClient
        yield* sql`INSERT INTO events ${sql.insert({
          stream_id: uid(7),
          event_type: "ProjectCreated",
          event_revision: 1,
          payload: "{not json"
        })}`
        return yield* collect(feed.read(0))
      }).pipe(Effect.exit),
      TestLayer
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) return
    const defects = exit.cause.reasons.filter(Cause.isDieReason).map(({ defect }) => defect)
    expect(defects).toHaveLength(1)
    const defect = defects[0]
    expect(defect).toBeInstanceOf(StoredEventMigrationError)
    if (!(defect instanceof StoredEventMigrationError)) return
    expect(defect).toMatchObject({
      reason: "invalid-json",
      input: {
        seq: 1,
        streamId: uid(7),
        eventType: "ProjectCreated",
        eventRevision: 1,
        payload: "{not json"
      },
      targetRevision: 2
    })
    expect(defect.failedRevision).toBeUndefined()
    expect(defect.cause).toMatchObject({ _tag: "SchemaError" })
  }))
})
