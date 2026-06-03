import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { SqlError } from "effect/unstable/sql/SqlError"
import type { Project, ProjectCreateResult, ProjectDeleteResult } from "@yodea/contracts/project"
import { ProjectAlreadyExists, ProjectDirectoryConflict, ProjectDirectoryInvalid, ProjectNameConflict, ProjectNotFound } from "@yodea/contracts/rpc"
import { EventStore } from "@yodea/db/event-store"
import { EventBus } from "@yodea/application/event-bus"
import { ProjectProjection } from "@yodea/application/projections"
import { ProjectArchived, ProjectCreated, ProjectDeleted, ProjectDirectoryChanged, ProjectMetadataChanged, ProjectRenamed, ProjectRestored } from "@yodea/contracts/events"
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
  readonly archiveProject: (id: string) => Effect.Effect<Project, ProjectNotFound | UseCaseError>
  readonly restoreProject: (id: string) => Effect.Effect<Project, ProjectNotFound | UseCaseError>
  readonly setMetadata: (
    id: string,
    patch: { description?: string | null; tags?: ReadonlyArray<string> }
  ) => Effect.Effect<Project, ProjectNotFound | UseCaseError>
  readonly deleteProject: (id: string) => Effect.Effect<ProjectDeleteResult, ProjectNotFound | UseCaseError>
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

    // Archive/restore is a pure toggle of the `archived` flag — no uniqueness
    // check (toggling cannot collide). Validate the target exists in the FULL
    // non-deleted set (archived included), append the toggle event, publish, and
    // return the freshly re-folded project (falling back to `existing` on a fold
    // miss). `toggleArchived` keeps both directions in lockstep.
    const toggleArchived = (
      id: string,
      makeEvent: (occurredAt: string) => typeof ProjectArchived.Type | typeof ProjectRestored.Type
    ) =>
      Effect.gen(function* () {
        const all = yield* projection.list
        const existing = all.find((p) => p.id === id)
        if (existing === undefined) return yield* Effect.fail(new ProjectNotFound({ id }))
        const event = makeEvent(new Date().toISOString())
        yield* store.append(id, event)
        yield* bus.publish(event)
        const updated = (yield* projection.list).find((p) => p.id === id)
        return updated ?? existing
      })

    const archiveProject = (id: string) =>
      toggleArchived(id, (occurredAt) => ProjectArchived.make({ projectId: id, occurredAt }))
    const restoreProject = (id: string) =>
      toggleArchived(id, (occurredAt) => ProjectRestored.make({ projectId: id, occurredAt }))

    // Set metadata (replace-style). Validate the target exists in the FULL
    // non-deleted set, then build a ProjectMetadataChanged carrying only the
    // provided fields (present description incl. null / present tags). Append THEN
    // publish, and return the freshly re-folded project (the fold dedupes tags +
    // stamps updatedAt).
    const setMetadata = (id: string, patch: { description?: string | null; tags?: ReadonlyArray<string> }) =>
      Effect.gen(function* () {
        const all = yield* projection.list
        const existing = all.find((p) => p.id === id)
        if (existing === undefined) return yield* Effect.fail(new ProjectNotFound({ id }))
        const occurredAt = new Date().toISOString()
        const event = ProjectMetadataChanged.make({
          projectId: id,
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
          occurredAt
        })
        yield* store.append(id, event)
        yield* bus.publish(event)
        const updated = (yield* projection.list).find((p) => p.id === id)
        return updated ?? existing
      })

    // Delete (soft tombstone). Validate the target exists in the FULL non-deleted
    // set (projection.list), append a ProjectDeleted event, publish, and return
    // { id, deleted: true }. The fold drops the id from every read-model and it
    // never reappears. A delete of an absent id fails ProjectNotFound.
    const deleteProject = (id: string) =>
      Effect.gen(function* () {
        const existing = (yield* projection.list).find((p) => p.id === id)
        if (existing === undefined) return yield* Effect.fail(new ProjectNotFound({ id }))
        const event = ProjectDeleted.make({ projectId: id, occurredAt: new Date().toISOString() })
        yield* store.append(id, event)
        yield* bus.publish(event)
        return { id, deleted: true } as const
      })

    // Default false: filter out archived. Deleted are already absent from the
    // fold. The full set (archived included) is reached with includeArchived:true,
    // which slices use for uniqueness checks.
    const listProjects = (includeArchived = false) =>
      Effect.map(projection.list, (ps) => includeArchived ? ps : ps.filter((p) => !p.archived))

    return { health, createProject, renameProject, changeDirectory, archiveProject, restoreProject, setMetadata, deleteProject, listProjects } as const
  })
}) {}

// v4 has no auto `.Default` layer — wire it manually with Layer.effect.
export const UseCasesLayer = Layer.effect(UseCases, UseCases.make)
