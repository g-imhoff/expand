import { type Context, Effect, Stream, SubscriptionRef } from "effect"
import type { Project, ProjectDeleteResult, ProjectId } from "@yodea/contracts/project"
import type { RendererProjectStoreShape } from "@yodea/desktop/renderer/features/projects/data/project-store"
import { supervised } from "@yodea/desktop/renderer/lib/supervised"

export interface AppHandle {
  readonly getProjects: () => ReadonlyArray<Project>
  readonly subscribe: (callback: () => void) => () => void
  readonly createProject: (name: string) => Promise<Project>
  readonly renameProject: (args: { readonly id: ProjectId; readonly name: string }) => Promise<Project>
  readonly changeDirectory: (args: { readonly id: ProjectId; readonly directory: string }) => Promise<Project>
  readonly archiveProject: (id: ProjectId) => Promise<Project>
  readonly restoreProject: (id: ProjectId) => Promise<Project>
  readonly setMetadata: (args: {
    readonly id: ProjectId
    readonly description?: string | null
    readonly tags?: ReadonlyArray<string>
  }) => Promise<Project>
  readonly deleteProject: (id: ProjectId) => Promise<ProjectDeleteResult>
  readonly health: () => Promise<string>
}

export const makeAppHandle = <R>(
  store: RendererProjectStoreShape,
  context: Context.Context<R>,
  health: () => Promise<string> = () => Promise.reject(new Error("health not wired"))
): AppHandle => {
  const run = Effect.runPromiseWith(context)

  // Synchronous snapshot mirror fed by SubscriptionRef.changes(store.projects).
  let snapshot: ReadonlyArray<Project> = SubscriptionRef.getUnsafe(store.projects)
  const listeners = new Set<() => void>()
  const emit = () => { for (const l of listeners) l() }

  // Fork a detached subscriber that updates the mirror and notifies React on every change.
  Effect.runForkWith(context)(
    supervised(
      "renderer projects mirror",
      Stream.runForEach(SubscriptionRef.changes(store.projects), (next) =>
        Effect.sync(() => {
          snapshot = next
          emit()
        })
      )
    )
  )

  return {
    getProjects: () => snapshot,
    subscribe: (callback) => {
      listeners.add(callback)
      return () => { listeners.delete(callback) }
    },
    createProject: (name) => run(store.createProject(name)),
    renameProject: (args) => run(store.renameProject(args)),
    changeDirectory: (args) => run(store.changeDirectory(args)),
    archiveProject: (id) => run(store.archiveProject(id)),
    restoreProject: (id) => run(store.restoreProject(id)),
    setMetadata: (args) => run(store.setMetadata(args)),
    deleteProject: (id) => run(store.deleteProject(id)),
    health
  }
}
