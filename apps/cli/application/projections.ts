import { Context, Effect, Layer, Schema } from "effect"
import { SqlError } from "effect/unstable/sql/SqlError"
import type { Project } from "@yodea/contracts/project"
import { EventStore } from "@yodea/db/event-store"
import { projectsFromEvents } from "@yodea/domain/project"

// `list` rebuilds the read-model from the event log, so it inherits the store's
// failure modes (SQL execution + payload codec).
type ProjectionError = SqlError | Schema.SchemaError

export class ProjectProjection extends Context.Service<ProjectProjection, {
  readonly list: Effect.Effect<ReadonlyArray<Project>, ProjectionError>
}>()("yodea/ProjectProjection", {
  // Requires EventStore — provided once by composition (shared instance).
  make: Effect.gen(function* () {
    const store = yield* EventStore
    const list = Effect.map(store.readAll, projectsFromEvents)
    return { list } as const
  })
}) {}

// v4 has no auto `.Default` layer — wire the layer from the stored `make` constructor.
export const ProjectProjectionLayer = Layer.effect(ProjectProjection, ProjectProjection.make)
