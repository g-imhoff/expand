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

// The projection boot graph against a file DB — identical shape to
// apps/server/composition/app.ts coreLayer, minus bus/use-cases/http.
export const projectionBootLayer = (dbPath: string, chunkSize?: number) => {
  const sql = SqliteClient.layer({ filename: dbPath })
  const base = ProjectEventStoreLayer.pipe(Layer.provide(sql))
  const projectEvents = chunkSize === undefined ? base : base.pipe(Layer.provide(Layer.succeed(EventScanChunkSize, chunkSize)))
  const states = ProjectionStateStoreLayer.pipe(Layer.provide(sql))
  return ProjectProjectionLayer.pipe(Layer.provide(projectEvents), Layer.provide(states))
}

export const runColdBoot = async (ctx: ScenarioContext): Promise<ReadonlyArray<Measurement>> => {
  deleteCheckpoint(ctx.dbPath)
  const { value: wallMs, rssDeltaBytes } = await withRss(() =>
    Effect.runPromise(timedLayerBuild(projectionBootLayer(ctx.dbPath, ctx.chunkSize)))
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
  ]
}
