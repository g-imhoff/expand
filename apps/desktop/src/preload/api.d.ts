import type { Project } from "@yodea/contracts/project"

export interface YodeaBridge {
  listProjects: () => Promise<ReadonlyArray<Project>>
  createProject: (name: string) => Promise<Project>
  onProjectsChanged: (cb: (projects: ReadonlyArray<Project>) => void) => () => void
}

declare global {
  interface Window {
    yodea: YodeaBridge
  }
}
