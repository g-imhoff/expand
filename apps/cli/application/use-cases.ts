import { Context, Effect, Layer, Schema } from "effect"
import { SqlError } from "effect/unstable/sql/SqlError"
import type { Project, ProjectCreateResult } from "@yodea/contracts/project"
import { ProjectAlreadyExists } from "@yodea/contracts/rpc"
import { EventStore } from "@yodea/db/event-store"
import { EventBus } from "@yodea/application/event-bus"
import { ProjectProjection } from "@yodea/application/projections"
import { ProjectCreated } from "@yodea/contracts/events"
import { newId } from "@yodea/lib/ids"

// The commit path appends to the EventStore and the read path rebuilds the
// projection — both inherit the store's failure modes (SQL execution + codec).
type UseCaseError = SqlError | Schema.SchemaError

export class UseCases extends Context.Service<UseCases, {
  readonly health: Effect.Effect<string>
  readonly createProject: (
    name: string,
    ensure: boolean
  ) => Effect.Effect<ProjectCreateResult, ProjectAlreadyExists | UseCaseError>
  readonly listProjects: (includeArchived?: boolean) => Effect.Effect<ReadonlyArray<Project>, UseCaseError>
}>()("yodea/UseCases", {
  make: Effect.gen(function* () {
    const store = yield* EventStore
    const bus = yield* EventBus
    const projection = yield* ProjectProjection

    const health = Effect.succeed("ok")

    // Commit path: durable append (source of truth) THEN live publish.
    // Append is the commit point; publish is best-effort live fan-out.
    //
    // Uniqueness is enforced by listing the projection then checking the name.
    // KNOWN LIMITATION: this list-then-check is a TOCTOU race — two concurrent
    // creates of the same name could both observe "absent" and both append.
    // Acceptable under I-2 (single backend instance, effectively serialized);
    // the deferred TxQueue closes the window with a serialized commit path.
    const createProject = (name: string, ensure: boolean) =>
      Effect.gen(function* () {
        const existing = (yield* projection.list).find((p) => p.name === name)
        if (existing !== undefined) {
          if (ensure) return { created: false, project: existing }
          return yield* Effect.fail(new ProjectAlreadyExists({ name }))
        }
        const id = newId()
        const createdAt = new Date().toISOString()
        const event = ProjectCreated.make({ projectId: id, name, createdAt })
        yield* store.append(id, event)
        yield* bus.publish(event)
        return {
          created: true,
          project: {
            id,
            name,
            directory: null,
            description: null,
            tags: [],
            archived: false,
            createdAt,
            updatedAt: createdAt
          }
        }
      })

    // Default false: filter out archived. Deleted are already absent from the
    // fold. The full set (archived included) is reached with includeArchived:true,
    // which slices use for uniqueness checks.
    const listProjects = (includeArchived = false) =>
      Effect.map(projection.list, (ps) => includeArchived ? ps : ps.filter((p) => !p.archived))

    return { health, createProject, listProjects } as const
  })
}) {}

// v4 has no auto `.Default` layer — wire it manually with Layer.effect.
export const UseCasesLayer = Layer.effect(UseCases, UseCases.make)
