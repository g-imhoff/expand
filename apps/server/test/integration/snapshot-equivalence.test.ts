import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Project } from "@yodea/contracts/project"
import { FOLD_VERSIONS } from "@yodea/contracts/fold-version.generated"
import type { DomainEvent } from "@yodea/contracts/events/domain"
import {
  ProjectArchived, ProjectCreated, ProjectDeleted, ProjectMetadataChanged, ProjectRenamed, ProjectRestored
} from "@yodea/contracts/events/project"
import { EventStore, EventStoreLayer } from "@yodea/server/db/event-store"
import { SnapshotStore, SnapshotStoreLayer } from "@yodea/server/db/snapshot-store"
import { ProjectProjection, ProjectProjectionLayer } from "@yodea/server/application/projections"
import { projectsFromEvents } from "@yodea/server/domain/project"

const uid = (n: number): string => "00000000-0000-4000-8000-" + String(n).padStart(12, "0")

// A representative sequence touching all 7 event types.
const script: ReadonlyArray<DomainEvent> = [
  ProjectCreated.make({ projectId: uid(1), name: "alpha", occurredAt: "t1" }),
  ProjectCreated.make({ projectId: uid(2), name: "beta", occurredAt: "t2" }),
  ProjectRenamed.make({ projectId: uid(1), name: "alpha2", occurredAt: "t3" }),
  ProjectMetadataChanged.make({ projectId: uid(2), description: "d", tags: ["x", "x", "y"], occurredAt: "t4" }),
  ProjectArchived.make({ projectId: uid(1), occurredAt: "t5" }),
  ProjectCreated.make({ projectId: uid(3), name: "gamma", occurredAt: "t6" }),
  ProjectRestored.make({ projectId: uid(1), occurredAt: "t7" }),
  ProjectDeleted.make({ projectId: uid(3), occurredAt: "t8" })
]

const layersFor = (dbPath: string) => {
  const Sql = SqliteClient.layer({ filename: dbPath })
  const Store = EventStoreLayer.pipe(Layer.provide(Sql))
  const Snapshots = SnapshotStoreLayer.pipe(Layer.provide(Sql))
  const Projection = ProjectProjectionLayer.pipe(Layer.provide(Store), Layer.provide(Snapshots))
  return Layer.mergeAll(Projection, Store, Snapshots).pipe(Layer.provideMerge(Sql))
}

describe("snapshot+tail equivalence", () => {
  it("booting from a snapshot at any k equals folding the whole log from zero", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yodea-equiv-"))
    const db = join(dir, "events.db")
    try {
      const fromZero = projectsFromEvents(script)

      for (let k = 0; k <= script.length; k++) {
        const fresh = join(dir, `k${k}.db`)
        // Seed the whole script via a Store-only build (no snapshot written).
        await Effect.runPromise(Effect.provide(
          Effect.flatMap(EventStore, (store) =>
            Effect.forEach(script, (e) => store.append((e as { projectId: string }).projectId, e), { discard: true })
          ),
          EventStoreLayer.pipe(Layer.provide(SqliteClient.layer({ filename: fresh })))
        ))
        // Force a snapshot exactly at seq k (k===0 means "no snapshot": skip the save).
        if (k > 0) {
          await Effect.runPromise(Effect.provide(
            Effect.gen(function* () {
              const store = yield* EventStore
              const snapshots = yield* SnapshotStore
              const rows = yield* store.readAll
              const prefix = rows.slice(0, k).map((r) => r.event)
              yield* snapshots.save({ projects: projectsFromEvents(prefix), seq: k, foldVersion: FOLD_VERSIONS.projects })
            }),
            Layer.mergeAll(EventStoreLayer, SnapshotStoreLayer).pipe(Layer.provideMerge(SqliteClient.layer({ filename: fresh })))
          ))
        }
        // Boot the projection: it loads snapshot@k and folds the tail.
        const booted = await Effect.runPromise(Effect.provide(
          Effect.flatMap(ProjectProjection, (p) => p.snapshot),
          layersFor(fresh)
        ))
        expect(booted.seq).toBe(script.length)
        expect(sortById(booted.projects)).toEqual(sortById(fromZero))
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("the two fold implementations agree (projectsFromEvents == reduce(foldList))", () => {
    const viaMap = projectsFromEvents(script)
    const viaList = script.reduce<ReadonlyArray<Project>>((acc, e) => Project.foldList(acc, e), [])
    expect(sortById(viaList)).toEqual(sortById(viaMap))
  })
})

const sortById = (ps: ReadonlyArray<Project>) => [...ps].sort((a, b) => a.id.localeCompare(b.id))
