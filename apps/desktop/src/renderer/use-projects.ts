import { useEffect, useState } from "react"
import { Effect } from "effect"
import type { Project } from "@yodea/contracts/project"
import type { YodeaBridge } from "@yodea/desktop/preload/api"

// The renderer never touches client-core/Node. It speaks only to window.yodea.
// The async IPC edge is wrapped with Effect.tryPromise (NOT Effect.promise): an
// ipcRenderer.invoke rejection — backend down, spawn failure, validation error
// in main, channel error — is expected and must land in the error channel, not
// become a defect. listProjects/createProject therefore surface a typed failure
// the UI can render instead of an unhandled rejection / silently-dead fiber.

// State the hook drives, exposed so it can be exercised without a DOM renderer.
export interface ProjectsState {
  setProjects: (projects: ReadonlyArray<Project>) => void
  setError: (error: string | null) => void
}

const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

// Seed via one-shot listProjects() then subscribe to onProjectsChanged. The main
// process pushes changes but does not replay a current value to a fresh
// subscriber, so the seed is needed. A push can land before the in-flight seed
// resolves, though, so an `applied` flag lets the (newer) push win: the stale
// seed is dropped once any update has been applied.
export const startProjects = (bridge: YodeaBridge, state: ProjectsState): (() => void) => {
  let applied = false
  let live = true

  const apply = (projects: ReadonlyArray<Project>) => {
    applied = true
    state.setProjects(projects)
  }

  const unsubscribe = bridge.onProjectsChanged((projects) => {
    if (live) apply(projects)
  })

  Effect.runPromise(
    Effect.tryPromise({
      try: () => bridge.listProjects(),
      catch: (cause) => new Error(message(cause))
    })
  ).then(
    (projects) => {
      // Only seed if nothing newer (a push) has already arrived.
      if (live && !applied) apply(projects)
    },
    (cause) => {
      if (live) state.setError(`Failed to load projects: ${message(cause)}`)
    }
  )

  return () => {
    live = false
    unsubscribe()
  }
}

export const createProject = (
  bridge: YodeaBridge,
  name: string,
  state: ProjectsState
): Promise<boolean> =>
  Effect.runPromise(
    Effect.tryPromise({
      try: () => bridge.createProject(name),
      catch: (cause) => new Error(message(cause))
    })
  ).then(
    () => {
      state.setError(null)
      return true
    },
    (cause) => {
      state.setError(`Failed to create project: ${message(cause)}`)
      return false
    }
  )

// The preload exposes the bridge on window.yodea. Read it through globalThis so
// this module typechecks under the (non-DOM) root tsconfig too — the renderer's
// own tsconfig still validates the YodeaBridge shape via api.d.ts.
const bridge = (): YodeaBridge => (globalThis as unknown as { yodea: YodeaBridge }).yodea

export const useProjects = () => {
  const [projects, setProjects] = useState<ReadonlyArray<Project>>([])
  const [error, setError] = useState<string | null>(null)
  const state: ProjectsState = { setProjects, setError }

  useEffect(() => startProjects(bridge(), state), [])

  // Resolves true on success, false on failure, so the caller can decide what to
  // do with the form (e.g. only clear the input when the project was created).
  const create = (name: string) => createProject(bridge(), name, state)

  return { projects, error, create }
}
