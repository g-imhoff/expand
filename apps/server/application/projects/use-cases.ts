import { Context, Effect, FileSystem, Layer, Path, Schema, Semaphore } from "effect"
import { SqlError } from "effect/unstable/sql/SqlError"
import { Project } from "@yodea/contracts/project"
import type { ProjectCreateResult, ProjectDeleteResult } from "@yodea/contracts/project"
import { ProjectAlreadyExists, ProjectDirectoryConflict, ProjectDirectoryInvalid, ProjectInvalidInput, ProjectNameConflict, ProjectNotFound } from "@yodea/contracts/rpc"
import { ProjectEventStore } from "@yodea/server/application/projects/project-event-store"
import type { ProjectEvent } from "@yodea/contracts/events/project"
import { EventBus } from "@yodea/server/application/event-bus"
import { ProjectProjection } from "@yodea/server/application/projections"
import { ProjectArchived, ProjectCreated, ProjectDeleted, ProjectDirectoryChanged, ProjectMetadataChanged, ProjectRenamed, ProjectRestored } from "@yodea/contracts/events/project"
import { newId } from "@yodea/server/lib/ids"

/**
 * Every project mutation — the only code that appends project events.
 *
 * @remarks
 * One mutex serializes each read-check-commit; one uninterruptible pipeline
 * commits (append → apply → publish, apply first so event reactions see the
 * updated read model); input is validated by decoding the next `Project`
 * through the contracts schema — failures become `ProjectInvalidInput`.
 */
export class ProjectUseCases extends Context.Service<ProjectUseCases, {
  /** Creates a uniquely named project; `ensure: true` returns an existing one (`created: false`) instead of failing, emitting no event. */
  readonly createProject: (
    name: string,
    ensure: boolean,
    directory?: string | null
  ) => Effect.Effect<ProjectCreateResult, ProjectAlreadyExists | ProjectDirectoryInvalid | ProjectDirectoryConflict | ProjectInvalidInput | UseCaseError>
  /** Renames; the new name must be brand-valid and unique. */
  readonly renameProject: (id: string, name: string) => Effect.Effect<Project, ProjectNotFound | ProjectNameConflict | ProjectInvalidInput | UseCaseError>
  /** Moves to an absolute, existing directory no other project claims (symlink-canonical check included). */
  readonly changeDirectory: (id: string, directory: string) => Effect.Effect<Project, ProjectNotFound | ProjectDirectoryInvalid | ProjectDirectoryConflict | UseCaseError>
  /** Archives (hidden from default listings); unguarded — re-archiving emits a redundant, harmless event. */
  readonly archiveProject: (id: string) => Effect.Effect<Project, ProjectNotFound | UseCaseError>
  /** Restores; unguarded like archive. */
  readonly restoreProject: (id: string) => Effect.Effect<Project, ProjectNotFound | UseCaseError>
  /** Patches description/tags: an absent key is untouched, `description: null` clears, tags are deduped by the fold. */
  readonly setMetadata: (
    id: string,
    patch: { description?: string | null; tags?: ReadonlyArray<string> }
  ) => Effect.Effect<Project, ProjectNotFound | ProjectInvalidInput | UseCaseError>
  /** Tombstone: gone from the read model, history stays in the log. */
  readonly deleteProject: (id: string) => Effect.Effect<ProjectDeleteResult, ProjectNotFound | UseCaseError>
  /** Zero-SQL projection read; archived filtered unless asked. Skips the mutex. */
  readonly listProjects: (includeArchived?: boolean) => Effect.Effect<ReadonlyArray<Project>, UseCaseError>
}>()("yodea/ProjectUseCases", {
  make: Effect.gen(function* () {
    const projectEvents = yield* ProjectEventStore
    const bus = yield* EventBus
    const projection = yield* ProjectProjection
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const mutex = yield* Semaphore.make(1)

    const commit = (event: ProjectEvent) =>
      Effect.uninterruptible(
        Effect.flatMap(projectEvents.append(event), (seq) =>
          projection.apply({ seq, event }).pipe(Effect.andThen(bus.publish({ seq, event })))
        )
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
        yield* commit(event)
        return { created: true, project } as const
      }))

    const renameProject = (id: string, name: string) =>
      mutex.withPermit(Effect.gen(function* () {
        const all = yield* projection.list
        const target = all.find((p) => p.id === id)
        if (target === undefined) return yield* Effect.fail(new ProjectNotFound({ id }))
        const occurredAt = new Date().toISOString()
        const renamed = yield* Schema.decodeUnknownEffect(Project)({ ...target, name, updatedAt: occurredAt })
          .pipe(Effect.mapError(toInvalidInput))
        if (all.some((p) => p.id !== id && p.name === renamed.name)) {
          return yield* Effect.fail(new ProjectNameConflict({ name: renamed.name }))
        }
        const event = ProjectRenamed.make({ projectId: id, name: renamed.name, occurredAt })
        yield* commit(event)
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
        yield* commit(event)
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
        yield* commit(event)
        return Project.applyEvent(existing, event)
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
        yield* commit(event)
        return Project.applyEvent(existing, event)
      }))

    const deleteProject = (id: string) =>
      mutex.withPermit(Effect.gen(function* () {
        const existing = (yield* projection.list).find((p) => p.id === id)
        if (existing === undefined) return yield* Effect.fail(new ProjectNotFound({ id }))
        const event = ProjectDeleted.make({ projectId: id, occurredAt: new Date().toISOString() })
        yield* commit(event)
        return { id, deleted: true } as const
      }))

    const listProjects = (includeArchived = false) =>
      Effect.map(projection.list, (ps) => includeArchived ? ps : ps.filter((p) => !p.archived))

    return { createProject, renameProject, changeDirectory, archiveProject, restoreProject, setMetadata, deleteProject, listProjects } as const
  })
}) {}

export const ProjectUseCasesLayer = Layer.effect(ProjectUseCases, ProjectUseCases.make)

const DIRECTORY_MAX_LENGTH = 4096

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

type UseCaseError = SqlError | Schema.SchemaError
