import { Context, Effect, Layer, Schema } from "effect"
import { SqlError } from "effect/unstable/sql/SqlError"
import type { Project } from "@yodea/contracts/project"
import { EventStore } from "@yodea/server/db/event-store"
import { projectsFromEvents } from "@yodea/server/domain/project"

type ProjectionError = SqlError | Schema.SchemaError

export class ProjectProjection extends Context.Service<ProjectProjection, {
  readonly list: Effect.Effect<ReadonlyArray<Project>, ProjectionError>
}>()("yodea/ProjectProjection", {
  make: Effect.gen(function*() {
    const store = yield* EventStore
    const list = Effect.map(store.readAll, projectsFromEvents)
    return { list } as const
  })
}) { }

export const ProjectProjectionLayer = Layer.effect(ProjectProjection, ProjectProjection.make)
