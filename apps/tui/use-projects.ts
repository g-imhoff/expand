import { useCallback, useContext, useEffect, useState } from "react"
import { Effect, Fiber, Schema, Stream, SubscriptionRef } from "effect"
import { ProjectStore, supervised } from "@yodea/client-core"
import type { Project } from "@yodea/contracts/project"
import { ProjectName, Tag, type ProjectId } from "@yodea/contracts/project"
import { RuntimeContext } from "@yodea/tui/runtime"

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
      case "SchemaError":
        return `invalid input: ${Schema.isSchemaError(cause) ? cause.message : String(tagged._tag)}`
      default:
        return cause instanceof Error ? cause.message : String(tagged._tag)
    }
  }
  return cause instanceof Error ? cause.message : String(cause)
}

export const useProjects = () => {
  const runtime = useContext(RuntimeContext)
  if (!runtime) throw new Error("useProjects must be used within a RuntimeContext")
  const [projects, setProjects] = useState<ReadonlyArray<Project>>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fiber = runtime.runFork(
      supervised(
        "tui projects subscription",
        Effect.flatMap(ProjectStore, (store) =>
          Stream.runForEach(SubscriptionRef.changes(store.projects), (ps) =>
            Effect.sync(() => setProjects(ps))))
      )
    )
    return () => {
      runtime.runFork(Fiber.interrupt(fiber))
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
    void runMutation(Effect.flatMap(ProjectName.makeEffect(name), (n) =>
      Effect.flatMap(ProjectStore, (s) => s.createProject(n))))
  }
  const rename = (id: ProjectId, name: string) => {
    void runMutation(Effect.flatMap(ProjectName.makeEffect(name), (n) =>
      Effect.flatMap(ProjectStore, (s) => s.renameProject(id, n))))
  }
  const changeDirectory = (id: ProjectId, directory: string) => {
    void runMutation(Effect.flatMap(ProjectStore, (s) => s.changeDirectory(id, directory)))
  }
  const archive = (id: ProjectId) => { void runMutation(Effect.flatMap(ProjectStore, (s) => s.archiveProject(id))) }
  const restore = (id: ProjectId) => { void runMutation(Effect.flatMap(ProjectStore, (s) => s.restoreProject(id))) }
  const setMetadata = (id: ProjectId, patch: { description?: string | null; tags?: ReadonlyArray<string> }) => {
    const tags = patch.tags === undefined
      ? Effect.succeed(undefined)
      : Effect.forEach(patch.tags, (t) => Tag.makeEffect(t))
    void runMutation(Effect.flatMap(tags, (ts) =>
      Effect.flatMap(ProjectStore, (s) => s.setMetadata(id, {
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(ts !== undefined ? { tags: ts } : {})
      }))))
  }
  const deleteProject = (id: ProjectId) => { void runMutation(Effect.flatMap(ProjectStore, (s) => s.deleteProject(id))) }
  const clearError = useCallback(() => setError(null), [])

  return { projects, error, clearError, create, rename, changeDirectory, archive, restore, setMetadata, deleteProject }
}
