import { createStore, type StoreApi } from "zustand/vanilla"
import { Effect } from "effect"
import type {
  ProjectSnapshot,
  ProjectSyncSink,
  ProjectSyncStatus
} from "@expand/contracts/project-sync"

export interface ProjectState extends ProjectSnapshot {
  readonly status: ProjectSyncStatus
}

export type ProjectsStore = StoreApi<ProjectState>

export const makeProjectsStore = (): ProjectsStore =>
  createStore<ProjectState>()(() => ({
    projects: [],
    seq: 0,
    status: "disconnected"
  }))

export const makeProjectSyncSink = (
  store: ProjectsStore
): ProjectSyncSink => ({
  snapshot: (snapshot) => Effect.sync(() => {
    store.setState(snapshot)
  }),
  status: (status) => Effect.sync(() => {
    store.setState({ status })
  })
})
