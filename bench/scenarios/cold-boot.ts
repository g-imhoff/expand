// S1 — cold boot: no checkpoint, from-zero streamed fold of the whole log.
import { Effect, Layer } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { EventScanChunkSize } from "@expand/server/db/event-store"
import { ProjectEventStoreLayer } from "@expand/server/application/projects/project-event-store"
import { ProjectProjectionLayer } from "@expand/server/application/projections"
import { ProjectionStateStoreLayer } from "@expand/server/db/projection-state-store"
import { deleteCheckpoint } from "../seed"
import { timedLayerBuild, withRss } from "../rss"
import type { Measurement, ScenarioContext } from "../report"
import { DatabaseReadyLayer } from "@expand/server/migrations/sqlite"

// The projection boot graph against a file DB — identical shape to
// apps/server/composition/app.ts coreLayer, minus bus/use-cases/http.
export const projectionBootLayer = (dbPath: string, chunkSize?: number) => {
  const sql = SqliteClient.layer({ filename: dbPath })
  const database = DatabaseReadyLayer.pipe(Layer.provideMerge(sql))
  const base = ProjectEventStoreLayer.pipe(Layer.provide(database))
  const projectEvents = chunkSize === undefined ? base : base.pipe(Layer.provide(Layer.succeed(EventScanChunkSize, chunkSize)))
  const states = ProjectionStateStoreLayer.pipe(Layer.provide(database))
  return ProjectProjectionLayer.pipe(Layer.provide(projectEvents), Layer.provide(states))
}

export const runColdBoot = Effect.fn("Benchmark.runColdBoot")(function*(ctx: ScenarioContext) {
  yield* deleteCheckpoint(ctx.dbPath)
  const { value: wallMs, rssDeltaBytes } = yield* withRss(
    timedLayerBuild(projectionBootLayer(ctx.dbPath, ctx.chunkSize))
  )
  return [
    {
      key: "s1-cold-boot",
      label: "S1 cold boot (from-zero fold)",
      scale: ctx.scale,
      wallMs,
      events: ctx.eventCount,
      rssDeltaBytes
    }
  ] satisfies ReadonlyArray<Measurement>
})
