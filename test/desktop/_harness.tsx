import { type ReactElement, type ReactNode } from "react"
import { render } from "@testing-library/react"
import type { Project, ProjectDeleteResult } from "@yodea/contracts/project"
import type { AppHandle } from "@yodea/desktop/renderer/app/app-handle"
import { AppHandleProvider } from "@yodea/desktop/renderer/app/AppHandleProvider"

export const fakeProject = (over: Partial<Project>): Project => ({
  id: "p1", name: "alpha", directory: null, description: null, tags: [],
  archived: false, createdAt: "t", updatedAt: "t", ...over
})

export const makeFakeAppHandle = (
  projects: ReadonlyArray<Project>,
  over: Partial<AppHandle> = {}
): AppHandle => {
  const unused = (label: string) => () => Promise.reject(new Error(`${label} not stubbed`))
  return {
    getProjects: () => projects,
    subscribe: () => () => {},
    createProject: unused("createProject") as AppHandle["createProject"],
    renameProject: unused("renameProject") as AppHandle["renameProject"],
    changeDirectory: unused("changeDirectory") as AppHandle["changeDirectory"],
    archiveProject: unused("archiveProject") as AppHandle["archiveProject"],
    restoreProject: unused("restoreProject") as AppHandle["restoreProject"],
    setMetadata: unused("setMetadata") as AppHandle["setMetadata"],
    deleteProject: unused("deleteProject") as () => Promise<ProjectDeleteResult>,
    health: unused("health") as AppHandle["health"],
    ...over
  }
}

export const renderWithHandle = (ui: ReactElement, handle: AppHandle) =>
  render(<AppHandleProvider value={handle}>{ui}</AppHandleProvider> as ReactNode)
