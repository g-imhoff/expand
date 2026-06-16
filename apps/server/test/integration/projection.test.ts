import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventStore, EventStoreLayer } from "@yodea/server/db/event-store"
import { SnapshotStore, SnapshotStoreLayer } from "@yodea/server/db/snapshot-store"
import { ProjectProjection, ProjectProjectionLayer } from "@yodea/server/application/projections"
import { ProjectCreated, ProjectRenamed } from "@yodea/contracts/events/project"

const uid = (n: number): string => "00000000-0000-4000-8000-" + String(n).padStart(12, "0")

// A fresh layer set over a real file DB. Each call BUILDS the projection, so its
// boot-catch-up runs against whatever is already persisted in the file.
const layersFor = (dbPath: string) => {
  const Sql = SqliteClient.layer({ filename: dbPath })
  const Store = EventStoreLayer.pipe(Layer.provide(Sql))
  const Snapshots = SnapshotStoreLayer.pipe(Layer.provide(Sql))
  const Projection = ProjectProjectionLayer.pipe(Layer.provide(Store), Layer.provide(Snapshots))
  return Layer.mergeAll(Projection, Store, Snapshots).pipe(Layer.provideMerge(Sql))
}
const on = <A, E>(dbPath: string, eff: Effect.Effect<A, E, ProjectProjection | EventStore | SnapshotStore | SqlClient>) =>
  Effect.runPromise(Effect.provide(eff, layersFor(dbPath)))

const withDb = async (body: (dbPath: string) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), "yodea-proj-"))
  try {
    await body(join(dir, "events.db"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("ProjectProjection — boot catch-up", () => {
  it("boots empty when the log is empty", async () => {
    await withDb(async (db) => {
      const snap = await on(db, Effect.flatMap(ProjectProjection, (p) => p.snapshot))
      expect(snap).toEqual({ projects: [], seq: 0 })
    })
  })

  it("rebuilds from zero when there is a log but no snapshot yet", async () => {
    await withDb(async (db) => {
      // Seed events with a Store-only build (no projection → no snapshot written).
      await Effect.runPromise(
        Effect.provide(
          Effect.flatMap(EventStore, (store) =>
            store.append(uid(1), ProjectCreated.make({ projectId: uid(1), name: "a", occurredAt: "t1" }))
          ),
          EventStoreLayer.pipe(Layer.provide(SqliteClient.layer({ filename: db })))
        )
      )
      // Now build the projection: boot finds no snapshot, folds from zero.
      const snap = await on(db, Effect.flatMap(ProjectProjection, (p) => p.snapshot))
      expect(snap.seq).toBe(1)
      expect(snap.projects.map((p) => p.name)).toEqual(["a"])
    })
  })

  it("folds only the tail after a stale snapshot, and advances it", async () => {
    await withDb(async (db) => {
      // First boot over one event → writes snapshot at seq 1.
      await on(db, Effect.flatMap(EventStore, (store) =>
        store.append(uid(1), ProjectCreated.make({ projectId: uid(1), name: "a", occurredAt: "t1" }))
      ).pipe(Effect.flatMap(() => Effect.flatMap(ProjectProjection, (p) => p.snapshot))))
      // Append more events directly (snapshot now stale at seq 1).
      await Effect.runPromise(
        Effect.provide(
          Effect.flatMap(EventStore, (store) =>
            store.append(uid(2), ProjectCreated.make({ projectId: uid(2), name: "b", occurredAt: "t2" }))
          ),
          EventStoreLayer.pipe(Layer.provide(SqliteClient.layer({ filename: db })))
        )
      )
      // Re-boot: loads snapshot@1, folds tail [seq2], reflects both, advances snapshot.
      const snap = await on(db, Effect.flatMap(ProjectProjection, (p) => p.snapshot))
      expect(snap.seq).toBe(2)
      expect(snap.projects.map((p) => p.name).sort()).toEqual(["a", "b"])
      const persisted = await on(db, Effect.flatMap(SnapshotStore, (s) => s.load))
      expect(persisted?.seq).toBe(2)
    })
  })

  it("ignores a foldVersion-mismatched snapshot and rebuilds from zero", async () => {
    await withDb(async (db) => {
      // Seed a real event, then save a bogus snapshot with a wrong foldVersion + wrong state.
      await on(db, Effect.gen(function* () {
        const store = yield* EventStore
        const snapshots = yield* SnapshotStore
        yield* store.append(uid(1), ProjectCreated.make({ projectId: uid(1), name: "real", occurredAt: "t1" }))
        yield* snapshots.save({ projects: [], seq: 0, foldVersion: "OLD" })
      }))
      // Re-boot: foldVersion "OLD" != current → ignore snapshot, fold from zero.
      const snap = await on(db, Effect.flatMap(ProjectProjection, (p) => p.snapshot))
      expect(snap.seq).toBe(1)
      expect(snap.projects.map((p) => p.name)).toEqual(["real"])
    })
  })

  it("apply advances the live model and is idempotent for non-advancing seqs", async () => {
    await withDb(async (db) => {
      const out = await on(db, Effect.gen(function* () {
        const p = yield* ProjectProjection
        const first = yield* p.apply({ seq: 1, event: ProjectCreated.make({ projectId: uid(1), name: "x", occurredAt: "t1" }) })
        const renamed = yield* p.apply({ seq: 2, event: ProjectRenamed.make({ projectId: uid(1), name: "y", occurredAt: "t2" }) })
        const stale = yield* p.apply({ seq: 2, event: ProjectRenamed.make({ projectId: uid(1), name: "z", occurredAt: "t3" }) })
        const snap = yield* p.snapshot
        return { first, renamed, stale, snap }
      }))
      expect(out.first).toBe(true)
      expect(out.renamed).toBe(true)
      expect(out.stale).toBe(false) // seq 2 not ahead of current 2 → no-op
      expect(out.snap.seq).toBe(2)
      expect(out.snap.projects[0]?.name).toBe("y")
    })
  })
})
