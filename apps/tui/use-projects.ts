import { useCallback, use, useEffect, useState } from "react"
import { Cause, Effect, Exit, Schema, SubscriptionRef } from "effect"
import { ClientSession } from "@expand/client-ts"
import { ProjectClient } from "@expand/client-ts/project"
import { runProjectSync, type ProjectSnapshot } from "@expand/contracts/project-sync"
import { RuntimeContext } from "@expand/tui/runtime"

export const useProjects = () => {
  const runtime = use(RuntimeContext)
  if (!runtime) throw new Error("useProjects must be used within a RuntimeContext")
  const [snapshot, setSnapshot] = useState<ProjectSnapshot>({
    projects: [],
    seq: 0
  })
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fiber = runtime.runFork(
      Effect.gen(function* () {
        const session = yield* ClientSession
        const client = yield* ProjectClient
        return yield* runProjectSync(
          {
            status: SubscriptionRef.changes(session.status),
            list: () => client.list({ includeArchived: true }),
            events: ({ fromSeq }) => client.events({ fromSeq })
          },
          {
            snapshot: (snapshot) => Effect.sync(() => setSnapshot(snapshot)),
            status: () => Effect.void
          }
        )
      })
    )
    const removeObserver = fiber.addObserver((exit) => {
      if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
        setError(describeError(Cause.squash(exit.cause)))
      }
    })
    return () => {
      removeObserver()
      fiber.interruptUnsafe()
    }
  }, [runtime])

  const runMutation = useCallback(
    async (mutation: Effect.Effect<unknown, unknown, ProjectClient>) => {
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
    void runMutation(Effect.flatMap(ProjectClient, (client) => client.create({ name, ensure: true })))
  }
  const rename = (id: string, name: string) => {
    void runMutation(Effect.flatMap(ProjectClient, (client) => client.rename({ id, name })))
  }
  const changeDirectory = (id: string, directory: string) => {
    void runMutation(Effect.flatMap(ProjectClient, (client) => client.changeDirectory({ id, directory })))
  }
  const archive = (id: string) => {
    void runMutation(Effect.flatMap(ProjectClient, (client) => client.archive({ id })))
  }
  const restore = (id: string) => {
    void runMutation(Effect.flatMap(ProjectClient, (client) => client.restore({ id })))
  }
  const setMetadata = (
    id: string,
    patch: { description?: string | null; tags?: ReadonlyArray<string> }
  ) => {
    void runMutation(Effect.flatMap(ProjectClient, (client) => client.setMetadata({ id, ...patch })))
  }
  const deleteProject = (id: string) => {
    void runMutation(Effect.flatMap(ProjectClient, (client) => client.delete({ id })))
  }
  const clearError = useCallback(() => setError(null), [])

  return {
    snapshot,
    projects: snapshot.projects,
    error,
    clearError,
    create,
    rename,
    changeDirectory,
    archive,
    restore,
    setMetadata,
    deleteProject
  }
}

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
      case "BackendUnavailable":
        return `backend unavailable: ${String(tagged.reason)}`
      default:
        return cause instanceof Error ? cause.message : String(tagged._tag)
    }
  }
  return cause instanceof Error ? cause.message : String(cause)
}
