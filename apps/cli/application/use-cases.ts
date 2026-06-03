import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { SqlError } from "effect/unstable/sql/SqlError"
import type { Project, ProjectCreateResult } from "@yodea/contracts/project"
import { ProjectAlreadyExists, ProjectDirectoryConflict, ProjectDirectoryInvalid, ProjectNameConflict, ProjectNotFound } from "@yodea/contracts/rpc"
import { EventStore } from "@yodea/db/event-store"
import { EventBus } from "@yodea/application/event-bus"
import { ProjectProjection } from "@yodea/application/projections"
import { ProjectCreated, ProjectDirectoryChanged, ProjectRenamed } from "@yodea/contracts/events"
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
  readonly renameProject: (
    id: string,
    name: string
  ) => Effect.Effect<Project, ProjectNotFound | ProjectNameConflict | UseCaseError>
  readonly changeDirectory: (
    id: string,
    directory: string
  ) => Effect.Effect<Project, ProjectNotFound | ProjectDirectoryInvalid | ProjectDirectoryConflict | UseCaseError>
  readonly listProjects: (includeArchived?: boolean) => Effect.Effect<ReadonlyArray<Project>, UseCaseError>
}>()("yodea/UseCases", {
  make: Effect.gen(function* () {
    const store = yield* EventStore
    const bus = yield* EventBus
    const projection = yield* ProjectProjection
    // FileSystem + Path are provided by coreLayer (BunFileSystem supplies
    // FileSystem, BunServices supplies Path) — used by changeDirectory to
    // validate the target path server-side.
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

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

    // Rename: validate the target exists, then check name-uniqueness against the
    // FULL non-deleted set (archived included, via projection.list) so an archived
    // project's name stays reserved. Append THEN publish, mirroring createProject.
    const renameProject = (id: string, name: string) =>
      Effect.gen(function* () {
        const all = yield* projection.list
        const target = all.find((p) => p.id === id)
        if (target === undefined) return yield* Effect.fail(new ProjectNotFound({ id }))
        if (all.some((p) => p.id !== id && p.name === name)) {
          return yield* Effect.fail(new ProjectNameConflict({ name }))
        }
        const occurredAt = new Date().toISOString()
        const event = ProjectRenamed.make({ projectId: id, name, occurredAt })
        yield* store.append(id, event)
        yield* bus.publish(event)
        return { ...target, name, updatedAt: occurredAt }
      })

    // Change a project's directory. Validation order: target exists -> path is
    // absolute -> path exists on disk -> not used by another live project (full
    // non-deleted set, archived included). fs.exists' PlatformError is discharged
    // as a defect (orDie) since the contract declares no infra error.
    const changeDirectory = (id: string, directory: string) =>
      Effect.gen(function* () {
        const all = yield* projection.list
        const existing = all.find((p) => p.id === id)
        if (existing === undefined) return yield* Effect.fail(new ProjectNotFound({ id }))
        if (!path.isAbsolute(directory)) {
          return yield* Effect.fail(new ProjectDirectoryInvalid({ directory, reason: "not-absolute" }))
        }
        const onDisk = yield* fs.exists(directory).pipe(Effect.orDie)
        if (!onDisk) {
          return yield* Effect.fail(new ProjectDirectoryInvalid({ directory, reason: "not-found" }))
        }
        if (all.some((p) => p.id !== id && p.directory === directory)) {
          return yield* Effect.fail(new ProjectDirectoryConflict({ directory }))
        }
        const occurredAt = new Date().toISOString()
        const event = ProjectDirectoryChanged.make({ projectId: id, directory, occurredAt })
        yield* store.append(id, event)
        yield* bus.publish(event)
        return { ...existing, directory, updatedAt: occurredAt }
      })

    // Default false: filter out archived. Deleted are already absent from the
    // fold. The full set (archived included) is reached with includeArchived:true,
    // which slices use for uniqueness checks.
    const listProjects = (includeArchived = false) =>
      Effect.map(projection.list, (ps) => includeArchived ? ps : ps.filter((p) => !p.archived))

    return { health, createProject, renameProject, changeDirectory, listProjects } as const
  })
}) {}

// v4 has no auto `.Default` layer — wire it manually with Layer.effect.
export const UseCasesLayer = Layer.effect(UseCases, UseCases.make)
