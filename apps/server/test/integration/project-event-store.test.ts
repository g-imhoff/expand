import { describe, expect, it } from "vitest"
import { Effect, Layer, Stream } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { PROJECT_EVENT_TAGS, ProjectEventStore, ProjectEventStoreLayer } from "@expand/server/application/projects/project-event-store"
import { ProjectCreated, ProjectEvent } from "@expand/contracts/events/project"

const uid = (n: number): string => "00000000-0000-4000-8000-" + String(n).padStart(12, "0")

const TestSql = SqliteClient.layer({ filename: ":memory:", disableWAL: true })
const TestLayer = ProjectEventStoreLayer.pipe(Layer.provideMerge(TestSql))

const run = <A, E>(eff: Effect.Effect<A, E, ProjectEventStore | SqlClient>) =>
  Effect.runPromise(Effect.provide(eff, TestLayer))

const collect = <A, E>(s: Stream.Stream<A, E>) =>
  Stream.runCollect(s).pipe(Effect.map((c) => Array.from(c)))

describe("ProjectEventStore", () => {
  it("PROJECT_EVENT_TAGS is the full project vocabulary, in lockstep with the union", () => {
    // Deliberate literal pin: adding an 8th project event must consciously touch this test.
    expect([...PROJECT_EVENT_TAGS].sort()).toEqual([
      "ProjectArchived", "ProjectCreated", "ProjectDeleted", "ProjectDirectoryChanged",
      "ProjectMetadataChanged", "ProjectRenamed", "ProjectRestored"
    ])
    expect([...PROJECT_EVENT_TAGS].sort()).toEqual(Object.keys(ProjectEvent.cases).sort())
  })

  it("read returns only project events — a foreign family's rows are invisible", async () => {
    const out = await run(
      Effect.gen(function* () {
        const events = yield* ProjectEventStore
        const sql = yield* SqlClient
        yield* events.append(ProjectCreated.make({ projectId: uid(1), name: "a", occurredAt: "t1" }))
        // A foreign family's row with a payload the DomainEvent union cannot decode:
        // the facade's filter must exclude it in SQL, so no decode (and no defect).
        yield* sql`INSERT INTO events ${sql.insert({ stream_id: uid(9), event_type: "ConversationStarted", payload: "{\"whatever\":true}" })}`
        yield* events.append(ProjectCreated.make({ projectId: uid(2), name: "b", occurredAt: "t2" }))
        return {
          all: yield* collect(events.read()),
          after: yield* collect(events.read(1))
        }
      })
    )
    expect(out.all.map((r) => r.seq)).toEqual([1, 3])       // seq 2 (foreign) filtered in SQL
    expect(out.after.map((r) => r.seq)).toEqual([3])         // strictly-after semantics
  })

  it("append derives stream_id from event.projectId — a mismatched id is unrepresentable", async () => {
    const out = await run(
      Effect.gen(function* () {
        const events = yield* ProjectEventStore
        const sql = yield* SqlClient
        const seq = yield* events.append(ProjectCreated.make({ projectId: uid(7), name: "derived", occurredAt: "t1" }))
        const rows = yield* sql<{ readonly stream_id: string }>`SELECT stream_id FROM events WHERE seq = ${seq}`
        return { seq, streamId: rows[0]?.stream_id }
      })
    )
    expect(out.seq).toBe(1)
    expect(out.streamId).toBe(uid(7))
  })
})
