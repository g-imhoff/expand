import { Context, Effect, Layer, Schema } from "effect"
import { SqlError } from "effect/unstable/sql/SqlError"
import type { Project } from "@yodea/contracts/project"
import { EventStore } from "@yodea/server/db/event-store"
import { projectsFromEvents } from "@yodea/server/domain/project"

type ProjectionError = SqlError | Schema.SchemaError

export class ProjectProjection extends Context.Service<ProjectProjection, {
  readonly list: Effect.Effect<ReadonlyArray<Project>, ProjectionError>
  readonly snapshot: Effect.Effect<{ readonly projects: ReadonlyArray<Project>; readonly seq: number }, ProjectionError>
}>()("yodea/ProjectProjection", {
  make: Effect.gen(function*() {
    const store = yield* EventStore
    const list = Effect.map(store.readAll, (rows) => projectsFromEvents(rows.map((r) => r.event)))
    const snapshot = Effect.map(store.readAll, (rows) => ({
      projects: projectsFromEvents(rows.map((r) => r.event)),
      seq: rows.length > 0 ? rows[rows.length - 1]!.seq : 0
    }))
    return { list, snapshot } as const
  })
}) { }

export const ProjectProjectionLayer = Layer.effect(ProjectProjection, ProjectProjection.make)
