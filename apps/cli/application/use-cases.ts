import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { SqlError } from "effect/unstable/sql/SqlError"
import type { Project, ProjectCreateResult, ProjectDeleteResult } from "@yodea/contracts/project"
import { ProjectAlreadyExists, ProjectDirectoryConflict, ProjectDirectoryInvalid, ProjectNameConflict, ProjectNotFound } from "@yodea/contracts/rpc"
import { EventStore } from "@yodea/db/event-store"
import { EventBus } from "@yodea/application/event-bus"
import { ProjectProjection } from "@yodea/application/projections"
import { ProjectArchived, ProjectCreated, ProjectDeleted, ProjectDirectoryChanged, ProjectMetadataChanged, ProjectRenamed, ProjectRestored } from "@yodea/contracts/events/project"
import { newId } from "@yodea/lib/ids"

type UseCaseError = SqlError | Schema.SchemaError

export class UseCases extends Context.Service<UseCases, {
  readonly health: Effect.Effect<string>
  readonly createProject: (
    name: string,
    ensure: boolean,
    directory?: string | null
  ) => Effect.Effect<ProjectCreateResult, ProjectAlreadyExists | ProjectDirectoryInvalid | ProjectDirectoryConflict | UseCaseError>
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
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const health = Effect.succeed("ok")

    const validateDirectory = (
      directory: string,
      projects: ReadonlyArray<Project>,
      selfId?: string
    ): Effect.Effect<void, ProjectDirectoryInvalid | ProjectDirectoryConflict> =>
      Effect.gen(function* () {
        if (!path.isAbsolute(directory)) {
          return yield* Effect.fail(new ProjectDirectoryInvalid({ directory, reason: "not-absolute" }))
        }
        const onDisk = yield* fs.exists(directory).pipe(Effect.orDie)
        if (!onDisk) {
          return yield* Effect.fail(new ProjectDirectoryInvalid({ directory, reason: "not-found" }))
        }
        if (projects.some((p) => p.id !== selfId && p.directory === directory)) {
          return yield* Effect.fail(new ProjectDirectoryConflict({ directory }))
        }
      })

    const createProject = (name: string, ensure: boolean, directory?: string | null) =>
      Effect.gen(function* () {
        const all = yield* projection.list
        const existing = all.find((p) => p.name === name)
        if (existing !== undefined) {
          if (ensure) return { created: false, project: existing }
          return yield* Effect.fail(new ProjectAlreadyExists({ name }))
        }
        if (typeof directory === "string") {
          yield* validateDirectory(directory, all)
        }
        const dir = typeof directory === "string" ? directory : null
        const id = newId()
        const createdAt = new Date().toISOString()
        const event = ProjectCreated.make({ projectId: id, name, directory: dir, createdAt })
        yield* store.append(id, event)
        yield* bus.publish(event)
        return {
          created: true,
          project: {
            id,
            name,
            directory: dir,
            description: null,
            tags: [],
            archived: false,
            createdAt,
            updatedAt: createdAt
          }
        }
      })

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

    const changeDirectory = (id: string, directory: string) =>
      Effect.gen(function* () {
        const all = yield* projection.list
        const existing = all.find((p) => p.id === id)
        if (existing === undefined) return yield* Effect.fail(new ProjectNotFound({ id }))
        yield* validateDirectory(directory, all, id)
        const occurredAt = new Date().toISOString()
        const event = ProjectDirectoryChanged.make({ projectId: id, directory, occurredAt })
        yield* store.append(id, event)
        yield* bus.publish(event)
        return { ...existing, directory, updatedAt: occurredAt }
      })

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

    const deleteProject = (id: string) =>
      Effect.gen(function* () {
        const existing = (yield* projection.list).find((p) => p.id === id)
        if (existing === undefined) return yield* Effect.fail(new ProjectNotFound({ id }))
        const event = ProjectDeleted.make({ projectId: id, occurredAt: new Date().toISOString() })
        yield* store.append(id, event)
        yield* bus.publish(event)
        return { id, deleted: true } as const
      })

    const listProjects = (includeArchived = false) =>
      Effect.map(projection.list, (ps) => includeArchived ? ps : ps.filter((p) => !p.archived))

    return { health, createProject, renameProject, changeDirectory, archiveProject, restoreProject, setMetadata, deleteProject, listProjects } as const
  })
}) {}

export const UseCasesLayer = Layer.effect(UseCases, UseCases.make)
