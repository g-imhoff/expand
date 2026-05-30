import { useEffect, useState } from "react"
import { Effect } from "effect"
import type { Project } from "@yodea/contracts/project"

// Renderer never touches client-core/Node. It speaks only to window.yodea, with
// the async IPC edge wrapped in Effect to stay Effect-first.
export const useProjects = () => {
  const [projects, setProjects] = useState<ReadonlyArray<Project>>([])
  useEffect(() => {
    Effect.runPromise(Effect.promise(() => window.yodea.listProjects())).then(setProjects)
    return window.yodea.onProjectsChanged(setProjects)
  }, [])
  const create = (name: string) =>
    Effect.runFork(Effect.promise(() => window.yodea.createProject(name)))
  return { projects, create }
}
