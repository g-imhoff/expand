import { type QueryClient } from "@tanstack/react-query"
import type { Project } from "@yodea/contracts/project"
import type { DomainEvent } from "@yodea/contracts/events"
import { foldEvent } from "@yodea/desktop/renderer/features/projects/event-fold"

// The projects query key + the live-event fold into the cache. DOM-free + React-free
// (only the framework-agnostic QueryClient) so it stays in the root tsc graph and is
// Bun-testable. The React hooks live in use-projects.ts.
export const PROJECTS_KEY = ["projects"] as const

export const applyEventToCache = (qc: QueryClient, event: DomainEvent): void => {
  qc.setQueryData<ReadonlyArray<Project>>(PROJECTS_KEY, (cur) => foldEvent(cur ?? [], event))
}
