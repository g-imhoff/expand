import { useContext, useEffect, useState } from "react"
import { Effect, Fiber, Stream, SubscriptionRef } from "effect"
import { ProjectStore } from "@yodea/client-core"
import type { Project } from "@yodea/contracts/project"
import { RuntimeContext } from "@yodea/tui/runtime"

export const useProjects = () => {
  const runtime = useContext(RuntimeContext)
  if (!runtime) throw new Error("useProjects must be used within a RuntimeContext")
  const [projects, setProjects] = useState<ReadonlyArray<Project>>([])

  useEffect(() => {
    // Drive the store's reactive ref into React state for the component's lifetime.
    const fiber = runtime.runFork(
      Effect.flatMap(ProjectStore, (store) =>
        Stream.runForEach(SubscriptionRef.changes(store.projects), (ps) =>
          Effect.sync(() => setProjects(ps))))
    )
    return () => {
      runtime.runFork(Fiber.interrupt(fiber))
    }
  }, [runtime])

  const create = (name: string) =>
    runtime.runFork(Effect.flatMap(ProjectStore, (s) => s.createProject(name)))

  const rename = (id: string, name: string) =>
    runtime.runFork(Effect.flatMap(ProjectStore, (s) => s.renameProject(id, name)))

  const changeDirectory = (id: string, directory: string) =>
    runtime.runFork(Effect.flatMap(ProjectStore, (s) => s.changeDirectory(id, directory)))

  return { projects, create, rename, changeDirectory }
}
