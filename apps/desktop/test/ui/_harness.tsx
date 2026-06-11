import { type ReactElement, type ReactNode } from "react"
import { render } from "@testing-library/react"
import type { Project, ProjectDeleteResult } from "@yodea/contracts/project"
import { Project as ProjectClass, ProjectId, ProjectName } from "@yodea/contracts/project"
import type { AppHandle } from "@yodea/desktop/renderer/app/app-handle"
import { AppHandleProvider } from "@yodea/desktop/renderer/app/AppHandleProvider"

export const uid = (n: number): string => "00000000-0000-4000-8000-" + String(n).padStart(12, "0")

interface FakeProjectOver {
  readonly id?: string
  readonly name?: string
  readonly directory?: string | null
  readonly description?: string | null
  readonly tags?: ReadonlyArray<string>
  readonly archived?: boolean
  readonly createdAt?: string
  readonly updatedAt?: string
}

export const fakeProject = (over: FakeProjectOver = {}): Project =>
  ProjectClass.make({
    id: ProjectId.make(over.id ?? uid(1)),
    name: ProjectName.make(over.name ?? "alpha"),
    directory: over.directory ?? null,
    description: over.description ?? null,
    tags: (over.tags ?? []) as Project["tags"],
    archived: over.archived ?? false,
    createdAt: over.createdAt ?? "t",
    updatedAt: over.updatedAt ?? "t"
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
