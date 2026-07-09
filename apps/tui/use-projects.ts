import { useCallback, use, useEffect, useState } from "react"
import { Effect, Schema } from "effect"
import { ProjectStore } from "@expand/client-ts/project"
import type { Project } from "@expand/contracts/project"
import { RuntimeContext } from "@expand/tui/runtime"

const describeError = (cause: unknown): string => {
  if (typeof cause === "object" && cause !== null && "_tag" in cause) {
    const tagged = cause as { _tag: string } & Record<string, unknown>
    switch (tagged._tag) {
      case "ProjectNameConflict":
      case "ProjectAlreadyExists":
        return `name conflict: "${String(tagged.name)}" already exists`
      case "ProjectNotFound":
        return `project not found: ${String(tagged.id)}`
      case "ProjectDirectoryInvalid":
        return `invalid directory ${String(tagged.directory)}: ${String(tagged.reason)}`
      case "ProjectDirectoryConflict":
        return `directory conflict: ${String(tagged.directory)} is already used by another project`
      case "ProjectInvalidInput":
        return `invalid ${String(tagged.field)}: ${String(tagged.reason)}`
      case "SchemaError":
        return `invalid input: ${Schema.isSchemaError(cause) ? cause.message : String(tagged._tag)}`
      default:
        return cause instanceof Error ? cause.message : String(tagged._tag)
    }
  }
  return cause instanceof Error ? cause.message : String(cause)
}

export const useProjects = () => {
  const runtime = use(RuntimeContext)
  if (!runtime) throw new Error("useProjects must be used within a RuntimeContext")
  const [projects, setProjects] = useState<ReadonlyArray<Project>>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // store.subscribe forks its own scoped fiber and hands back an unsubscribe;
    // we resolve that unsubscribe asynchronously and call it on cleanup.
    let unsubscribe: (() => void) | undefined
    let cancelled = false
    void runtime
      .runPromise(Effect.flatMap(ProjectStore, (store) => store.subscribe((ps) => setProjects(ps))))
      .then((stop) => {
        if (cancelled) stop()
        else unsubscribe = stop
      })
      // First-connect failure rejects the ManagedRuntime layer build (e.g.
      // BackendUnavailable). Surface it via the same error path the component
      // already uses instead of dropping it as an unhandled rejection.
      .catch((cause) => setError(describeError(cause)))
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [runtime])

  const runMutation = useCallback(
    async (mutation: Effect.Effect<unknown, unknown, ProjectStore>) => {
      try {
        await runtime.runPromise(mutation)
        setError(null)
      } catch (cause) {
        setError(describeError(cause))
      }
    },
    [runtime]
  )

  const create = (name: string) => {
    void runMutation(Effect.flatMap(ProjectStore, (s) => s.createProject(name)))
  }
  const rename = (id: string, name: string) => {
    void runMutation(Effect.flatMap(ProjectStore, (s) => s.renameProject(id, name)))
  }
  const changeDirectory = (id: string, directory: string) => {
    void runMutation(Effect.flatMap(ProjectStore, (s) => s.changeDirectory(id, directory)))
  }
  const archive = (id: string) => { void runMutation(Effect.flatMap(ProjectStore, (s) => s.archiveProject(id))) }
  const restore = (id: string) => { void runMutation(Effect.flatMap(ProjectStore, (s) => s.restoreProject(id))) }
  const setMetadata = (id: string, patch: { description?: string | null; tags?: ReadonlyArray<string> }) => {
    void runMutation(Effect.flatMap(ProjectStore, (s) => s.setMetadata(id, patch)))
  }
  const deleteProject = (id: string) => { void runMutation(Effect.flatMap(ProjectStore, (s) => s.deleteProject(id))) }
  const clearError = useCallback(() => setError(null), [])

  return { projects, error, clearError, create, rename, changeDirectory, archive, restore, setMetadata, deleteProject }
}
