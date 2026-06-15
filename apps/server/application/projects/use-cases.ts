import { Context, Effect, FileSystem, Layer, Path, Schema, Semaphore } from "effect"
import { SqlError } from "effect/unstable/sql/SqlError"
import { Project } from "@yodea/contracts/project"
import type { ProjectCreateResult, ProjectDeleteResult } from "@yodea/contracts/project"
import { ProjectAlreadyExists, ProjectDirectoryConflict, ProjectDirectoryInvalid, ProjectInvalidInput, ProjectNameConflict, ProjectNotFound } from "@yodea/contracts/rpc"
import { EventStore } from "@yodea/server/db/event-store"
import { EventBus } from "@yodea/server/application/event-bus"
import { ProjectProjection } from "@yodea/server/application/projections"
import { ProjectArchived, ProjectCreated, ProjectDeleted, ProjectDirectoryChanged, ProjectMetadataChanged, ProjectRenamed, ProjectRestored } from "@yodea/contracts/events/project"
import { newId } from "@yodea/server/lib/ids"

const DIRECTORY_MAX_LENGTH = 4096

// This is the system's single ingestion boundary: raw client input is validated
// HERE — by constructing a Project from it (Schema.decodeUnknown) before any
// event is written. A construction failure becomes a typed ProjectInvalidInput
// that travels back over RPC. `fieldOf` walks the SchemaError's issue tree to
// recover which field failed (e.g. "name", "tags", "description").
const fieldOf = (e: Schema.SchemaError): string => {
  const visit = (issue: unknown): string | undefined => {
    if (issue === null || typeof issue !== "object") return undefined
    const i = issue as {
      readonly _tag?: string
      readonly path?: ReadonlyArray<PropertyKey>
      readonly issue?: unknown
      readonly issues?: ReadonlyArray<unknown>
    }
    if (i._tag === "Pointer" && i.path !== undefined && i.path.length > 0) return String(i.path[0])
    if (i.issue !== undefined) {
      const found = visit(i.issue)
      if (found !== undefined) return found
    }
    if (i.issues !== undefined) {
      for (const child of i.issues) {
        const found = visit(child)
        if (found !== undefined) return found
      }
    }
    return undefined
  }
  return visit(e.issue) ?? "input"
}
const toInvalidInput = (e: Schema.SchemaError) => new ProjectInvalidInput({ field: fieldOf(e), reason: e.message })

export class ProjectUseCases extends Context.Service<ProjectUseCases, {
  readonly createProject: (
    name: string,
    ensure: boolean,
    directory?: string | null
  ) => Effect.Effect<ProjectCreateResult, ProjectAlreadyExists | ProjectDirectoryInvalid | ProjectDirectoryConflict | ProjectInvalidInput | UseCaseError>
  readonly renameProject: (id: string, name: string) => Effect.Effect<Project, ProjectNotFound | ProjectNameConflict | ProjectInvalidInput | UseCaseError>
  readonly changeDirectory: (id: string, directory: string) => Effect.Effect<Project, ProjectNotFound | ProjectDirectoryInvalid | ProjectDirectoryConflict | UseCaseError>
  readonly archiveProject: (id: string) => Effect.Effect<Project, ProjectNotFound | UseCaseError>
  readonly restoreProject: (id: string) => Effect.Effect<Project, ProjectNotFound | UseCaseError>
  readonly setMetadata: (
    id: string,
    patch: { description?: string | null; tags?: ReadonlyArray<string> }
  ) => Effect.Effect<Project, ProjectNotFound | ProjectInvalidInput | UseCaseError>
  readonly deleteProject: (id: string) => Effect.Effect<ProjectDeleteResult, ProjectNotFound | UseCaseError>
  readonly listProjects: (includeArchived?: boolean) => Effect.Effect<ReadonlyArray<Project>, UseCaseError>
}>()("yodea/ProjectUseCases", {
  make: Effect.gen(function* () {
    const store = yield* EventStore
    const bus = yield* EventBus
    const projection = yield* ProjectProjection
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const mutex = yield* Semaphore.make(1)

    const commit = (id: string, event: Parameters<typeof store.append>[1]) =>
      Effect.uninterruptible(
        Effect.flatMap(store.append(id, event), (seq) => bus.publish({ seq, event }))
      )

    const validateDirectory = (
      directory: string,
      projects: ReadonlyArray<Project>,
      selfId?: string
    ): Effect.Effect<void, ProjectDirectoryInvalid | ProjectDirectoryConflict> =>
      Effect.gen(function* () {
        if (directory.length > DIRECTORY_MAX_LENGTH) {
          return yield* Effect.fail(new ProjectDirectoryInvalid({ directory, reason: "too-long" }))
        }
        if (!path.isAbsolute(directory)) {
          return yield* Effect.fail(new ProjectDirectoryInvalid({ directory, reason: "not-absolute" }))
        }
        const info = yield* fs.stat(directory).pipe(
          Effect.mapError(() => new ProjectDirectoryInvalid({ directory, reason: "not-found" }))
        )
        if (info.type !== "Directory") {
          return yield* Effect.fail(new ProjectDirectoryInvalid({ directory, reason: "not-a-directory" }))
        }
        const canonical = yield* fs.realPath(directory).pipe(Effect.orDie)
        if (projects.some((p) => p.id !== selfId && (p.directory === directory || p.directory === canonical))) {
          return yield* Effect.fail(new ProjectDirectoryConflict({ directory }))
        }
      })

    const createProject = (name: string, ensure: boolean, directory?: string | null) =>
      mutex.withPermit(Effect.gen(function* () {
        const dir = typeof directory === "string" ? directory : null
        const id = newId()
        const createdAt = new Date().toISOString()
        // Validate by building the Project: name/id/tags all checked here at once.
        const project = yield* Schema.decodeUnknownEffect(Project)({
          id, name, directory: dir, description: null, tags: [], archived: false, createdAt, updatedAt: createdAt
        }).pipe(Effect.mapError(toInvalidInput))
        const all = yield* projection.list
        const existing = all.find((p) => p.name === project.name)
        if (existing !== undefined) {
          if (ensure) return { created: false, project: existing } as const
          return yield* Effect.fail(new ProjectAlreadyExists({ name: project.name }))
        }
        if (typeof directory === "string") {
          yield* validateDirectory(directory, all)
        }
        const event = ProjectCreated.make({ projectId: id, name: project.name, directory: dir, occurredAt: createdAt })
        yield* commit(id, event)
        return { created: true, project } as const
      }))

    const renameProject = (id: string, name: string) =>
      mutex.withPermit(Effect.gen(function* () {
        const all = yield* projection.list
        const target = all.find((p) => p.id === id)
        if (target === undefined) return yield* Effect.fail(new ProjectNotFound({ id }))
        const occurredAt = new Date().toISOString()
        // Validate the new name by building the next Project state.
        const renamed = yield* Schema.decodeUnknownEffect(Project)({ ...target, name, updatedAt: occurredAt })
          .pipe(Effect.mapError(toInvalidInput))
        if (all.some((p) => p.id !== id && p.name === renamed.name)) {
          return yield* Effect.fail(new ProjectNameConflict({ name: renamed.name }))
        }
        const event = ProjectRenamed.make({ projectId: id, name: renamed.name, occurredAt })
        yield* commit(id, event)
        return renamed
      }))

    const changeDirectory = (id: string, directory: string) =>
      mutex.withPermit(Effect.gen(function* () {
        const all = yield* projection.list
        const existing = all.find((p) => p.id === id)
        if (existing === undefined) return yield* Effect.fail(new ProjectNotFound({ id }))
        yield* validateDirectory(directory, all, id)
        const occurredAt = new Date().toISOString()
        const event = ProjectDirectoryChanged.make({ projectId: id, directory, occurredAt })
        yield* commit(id, event)
        return Project.applyEvent(existing, event)
      }))

    const toggleArchived = (
      id: string,
      makeEvent: (occurredAt: string) => typeof ProjectArchived.Type | typeof ProjectRestored.Type
    ) =>
      mutex.withPermit(Effect.gen(function* () {
        const all = yield* projection.list
        const existing = all.find((p) => p.id === id)
        if (existing === undefined) return yield* Effect.fail(new ProjectNotFound({ id }))
        const event = makeEvent(new Date().toISOString())
        yield* commit(id, event)
        const updated = (yield* projection.list).find((p) => p.id === id)
        return updated ?? existing
      }))

    const archiveProject = (id: string) =>
      toggleArchived(id, (occurredAt) => ProjectArchived.make({ projectId: id, occurredAt }))
    const restoreProject = (id: string) =>
      toggleArchived(id, (occurredAt) => ProjectRestored.make({ projectId: id, occurredAt }))

    const setMetadata = (id: string, patch: { description?: string | null; tags?: ReadonlyArray<string> }) =>
      mutex.withPermit(Effect.gen(function* () {
        const all = yield* projection.list
        const existing = all.find((p) => p.id === id)
        if (existing === undefined) return yield* Effect.fail(new ProjectNotFound({ id }))
        // Validate the patched fields by building the next Project state.
        const next = yield* Schema.decodeUnknownEffect(Project)({
          ...existing,
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.tags !== undefined ? { tags: patch.tags } : {})
        }).pipe(Effect.mapError(toInvalidInput))
        const occurredAt = new Date().toISOString()
        const event = ProjectMetadataChanged.make({
          projectId: id,
          ...(patch.description !== undefined ? { description: next.description } : {}),
          ...(patch.tags !== undefined ? { tags: next.tags } : {}),
          occurredAt
        })
        yield* commit(id, event)
        const updated = (yield* projection.list).find((p) => p.id === id)
        return updated ?? existing
      }))

    const deleteProject = (id: string) =>
      mutex.withPermit(Effect.gen(function* () {
        const existing = (yield* projection.list).find((p) => p.id === id)
        if (existing === undefined) return yield* Effect.fail(new ProjectNotFound({ id }))
        const event = ProjectDeleted.make({ projectId: id, occurredAt: new Date().toISOString() })
        yield* commit(id, event)
        return { id, deleted: true } as const
      }))

    const listProjects = (includeArchived = false) =>
      Effect.map(projection.list, (ps) => includeArchived ? ps : ps.filter((p) => !p.archived))

    return { createProject, renameProject, changeDirectory, archiveProject, restoreProject, setMetadata, deleteProject, listProjects } as const
  })
}) {}

export const ProjectUseCasesLayer = Layer.effect(ProjectUseCases, ProjectUseCases.make)

type UseCaseError = SqlError | Schema.SchemaError
