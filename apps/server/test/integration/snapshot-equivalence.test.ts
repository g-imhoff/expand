import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, FileSystem, Layer, Path, Schema, Stream } from "effect"
import { NodeServices } from "@effect/platform-node"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Project } from "@expand/contracts/project"
import { FOLD_VERSIONS } from "@expand/contracts/fold-version.generated"
import type { DomainEvent } from "@expand/contracts/events/domain"
import {
  ProjectArchived, ProjectCreated, ProjectDeleted, ProjectMetadataChanged, ProjectRenamed, ProjectRestored
} from "@expand/contracts/events/project"
import { ReplayFeed, ReplayFeedLayer } from "@expand/server/db/replay-feed"
import { ProjectEventStore, ProjectEventStoreLayer } from "@expand/server/application/projects/project-event-store"
import { ProjectionStateStore, ProjectionStateStoreLayer } from "@expand/server/db/projection-state-store"
import { ProjectProjection, ProjectProjectionLayer, PROJECTION_NAME } from "@expand/server/application/projections"
import { DatabaseReadyLayer } from "@expand/server/migrations/sqlite"

const uid = (n: number): string => "00000000-0000-4000-8000-" + String(n).padStart(12, "0")

const foldAll = (events: ReadonlyArray<DomainEvent>): ReadonlyArray<Project> =>
  events.reduce<ReadonlyArray<Project>>((acc, e) => Project.foldList(acc, e), [])

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
  const Database = DatabaseReadyLayer.pipe(Layer.provideMerge(Sql))
  const ProjectEvents = ProjectEventStoreLayer.pipe(Layer.provide(Database))
  const States = ProjectionStateStoreLayer.pipe(Layer.provide(Database))
  const Projection = ProjectProjectionLayer.pipe(Layer.provide(ProjectEvents), Layer.provide(States))
  return Layer.mergeAll(Projection, States).pipe(Layer.provideMerge(Database))
}

const eventStoreFor = (dbPath: string) => {
  const Sql = SqliteClient.layer({ filename: dbPath })
  const Database = DatabaseReadyLayer.pipe(Layer.provideMerge(Sql))
  return ProjectEventStoreLayer.pipe(Layer.provide(Database))
}

const replayAndStateFor = (dbPath: string) => {
  const Sql = SqliteClient.layer({ filename: dbPath })
  const Database = DatabaseReadyLayer.pipe(Layer.provideMerge(Sql))
  return Layer.mergeAll(ReplayFeedLayer, ProjectionStateStoreLayer).pipe(Layer.provide(Database))
}

describe("snapshot+tail equivalence", () => {
  it.live("booting from a snapshot at any k equals folding the whole log from zero",  () => Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "expand-equiv-" })
    const fromZero = foldAll(script)

      for (let k = 0; k <= script.length; k++) {
        const fresh = path.join(dir, `k${k}.db`)
        // Seed the whole script via an events-only build (no snapshot written).
        yield* (Effect.provide(
          Effect.flatMap(ProjectEventStore, (events) =>
            Effect.forEach(script, (e) => events.append(e), { discard: true })
          ),
          eventStoreFor(fresh)
        ))
        // Force a snapshot exactly at seq k (k===0 means "no snapshot": skip the save).
        if (k > 0) {
          yield* (Effect.provide(
            Effect.gen(function* () {
              const feed = yield* ReplayFeed
              const snapshots = yield* ProjectionStateStore
              const rows = yield* Stream.runCollect(feed.read(0)).pipe(Effect.map((c) => Array.from(c)))
              const prefix = rows.slice(0, k).map((r) => r.event)
              const state = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Project)))(foldAll(prefix)).pipe(Effect.orDie)
              yield* snapshots.save(PROJECTION_NAME, { state, lastSeq: k, foldVersion: FOLD_VERSIONS.projects })
            }),
            replayAndStateFor(fresh)
          ))
        }
        // Boot the projection: it loads snapshot@k and folds the tail.
        const booted = yield* (Effect.provide(
          Effect.flatMap(ProjectProjection, (p) => p.snapshot),
          layersFor(fresh)
        ))
        expect(booted.seq).toBe(script.length)
        expect(sortById(booted.projects)).toEqual(sortById(fromZero))
      }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})

const sortById = (ps: ReadonlyArray<Project>) => [...ps].sort((a, b) => a.id.localeCompare(b.id))
