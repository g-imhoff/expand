import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Project } from "@yodea/contracts/project"
import { ProjectCreated } from "@yodea/contracts/events/project"
import { SnapshotStore, SnapshotStoreLayer } from "@yodea/server/db/snapshot-store"

const uid = (n: number): string => "00000000-0000-4000-8000-" + String(n).padStart(12, "0")
// Build via the canonical constructor so branded fields (ProjectId/ProjectName) are
// well-typed without casts.
const proj = (n: number): Project =>
  Project.fromCreated(ProjectCreated.make({ projectId: uid(n), name: `p${n}`, occurredAt: "t" }))

const TestSql = SqliteClient.layer({ filename: ":memory:", disableWAL: true })
const TestLayer = SnapshotStoreLayer.pipe(Layer.provideMerge(TestSql))

const run = <A, E>(eff: Effect.Effect<A, E, SnapshotStore | SqlClient>) =>
  Effect.runPromise(Effect.provide(eff, TestLayer))

describe("SnapshotStore", () => {
  it("returns null when no snapshot has been saved", async () => {
    const r = await run(Effect.flatMap(SnapshotStore, (s) => s.load))
    expect(r).toBe(null)
  })

  it("round-trips a saved snapshot (projects, seq, foldVersion)", async () => {
    const r = await run(
      Effect.gen(function* () {
        const s = yield* SnapshotStore
        yield* s.save({ projects: [proj(1), proj(2)], seq: 7, foldVersion: "1" })
        return yield* s.load
      })
    )
    expect(r?.seq).toBe(7)
    expect(r?.foldVersion).toBe("1")
    expect(r?.projects.map((p) => p.id)).toEqual([uid(1), uid(2)])
  })

  it("save overwrites the single row (latest wins)", async () => {
    const r = await run(
      Effect.gen(function* () {
        const s = yield* SnapshotStore
        yield* s.save({ projects: [proj(1)], seq: 1, foldVersion: "1" })
        yield* s.save({ projects: [proj(1), proj(2)], seq: 2, foldVersion: "1" })
        return yield* s.load
      })
    )
    expect(r?.seq).toBe(2)
    expect(r?.projects).toHaveLength(2)
  })

  it("returns null (does not throw) when the stored projects payload is corrupt", async () => {
    const r = await run(
      Effect.gen(function* () {
        const s = yield* SnapshotStore
        const sql = yield* SqlClient
        yield* s.save({ projects: [proj(1)], seq: 1, foldVersion: "1" })
        yield* sql`UPDATE snapshot SET projects = '{ not json' WHERE id = 0`
        return yield* s.load
      })
    )
    expect(r).toBe(null)
  })
})
