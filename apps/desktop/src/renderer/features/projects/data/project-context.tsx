import { createContext, type ReactNode, useContext } from "react"
import { useStore } from "zustand"
import type { ProjectState, ProjectsStore } from "@expand/desktop/renderer/features/projects/data/project-store"
import type { ProjectRpcApi } from "@expand/desktop/renderer/rpc/project-rpc"

export interface ProjectContextValue {
  readonly store: ProjectsStore
  readonly rpc: ProjectRpcApi
}

export const ProjectContextProvider = ({
  value,
  children
}: {
  readonly value: ProjectContextValue
  readonly children: ReactNode
}) => <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>

export const useProjectSelector = <A,>(selector: (state: ProjectState) => A): A => {
  const value = useProjectContext()
  return useStore(value.store, selector)
}

export const useProjectRpc = (): ProjectRpcApi => useProjectContext().rpc

const useProjectContext = (): ProjectContextValue => {
  const value = useContext(ProjectContext)
  if (value === null) {
    throw new Error("project context must be used within <ProjectContextProvider>")
  }
  return value
}

const ProjectContext = createContext<ProjectContextValue | null>(null)
