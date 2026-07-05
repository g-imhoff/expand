import { describe, expect, it } from "vitest"
import { Cause, Effect, Layer, Stream } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { ReplayFeed, ReplayFeedLayer } from "@yodea/server/db/replay-feed"
import { ProjectEventStore, ProjectEventStoreLayer } from "@yodea/server/application/projects/project-event-store"
import { ProjectCreated } from "@yodea/contracts/events/project"

const uid = (n: number): string => "00000000-0000-4000-8000-" + String(n).padStart(12, "0")
const ev = (n: number) => ProjectCreated.make({ projectId: uid(n), name: `p${n}`, occurredAt: `t${n}` })

const TestSql = SqliteClient.layer({ filename: ":memory:", disableWAL: true })
const TestLayer = Layer.mergeAll(ReplayFeedLayer, ProjectEventStoreLayer).pipe(Layer.provideMerge(TestSql))

const run = <A, E>(eff: Effect.Effect<A, E, ReplayFeed | ProjectEventStore | SqlClient>) =>
  Effect.runPromise(Effect.provide(eff, TestLayer))

const collect = <A, E>(s: Stream.Stream<A, E>) =>
  Stream.runCollect(s).pipe(Effect.map((c) => Array.from(c)))

describe("ReplayFeed", () => {
  it("reads the whole log strictly after the cursor, in seq order", async () => {
    const out = await run(
      Effect.gen(function* () {
        const events = yield* ProjectEventStore
        const feed = yield* ReplayFeed
        for (let n = 1; n <= 3; n++) yield* events.append(ev(n))
        return { all: yield* collect(feed.read(0)), after: yield* collect(feed.read(1)) }
      })
    )
    expect(out.all.map((se) => se.seq)).toEqual([1, 2, 3])
    expect(out.after.map((se) => se.seq)).toEqual([2, 3])
  })

  it("is unfiltered: a foreign undecodable row is a defect, not silently skipped", async () => {
    // The deliberate contrast with ProjectEventStore.read (which excludes foreign
    // rows in SQL): the sync feed serves EVERYTHING, so a bad row must die loudly.
    const exit = await Effect.runPromise(Effect.provide(
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
  })
})
