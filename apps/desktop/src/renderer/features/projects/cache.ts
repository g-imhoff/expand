import { type QueryClient } from "@tanstack/react-query"
import type { Project } from "@yodea/contracts/project"
import type { DomainEvent } from "@yodea/contracts/events"
import { foldEvent } from "@yodea/desktop/renderer/features/projects/event-fold"

export const PROJECTS_KEY = ["projects"] as const
export const ALL_PROJECTS_KEY = ["projects", "all"] as const

export const applyEventToCache = (qc: QueryClient, event: DomainEvent): void => {
  qc.setQueryData<ReadonlyArray<Project>>(PROJECTS_KEY, (cur) => foldEvent(cur ?? [], event))
  qc.setQueryData<ReadonlyArray<Project>>(ALL_PROJECTS_KEY, (cur) => foldEvent(cur ?? [], event))
}
