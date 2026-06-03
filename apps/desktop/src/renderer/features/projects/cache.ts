import { type QueryClient } from "@tanstack/react-query"
import type { Project } from "@yodea/contracts/project"
import type { DomainEvent } from "@yodea/contracts/events"
import { foldEvent } from "@yodea/desktop/renderer/features/projects/event-fold"

// The projects query keys + the live-event fold into the cache. DOM-free + React-free
// (only the framework-agnostic QueryClient) so it stays in the root tsc graph and is
// Bun-testable. The React hooks live in use-projects.ts.
//
// Two keys, one fold:
//  - PROJECTS_KEY        — the default list (seeded from ProjectList({}), archived
//                          hidden, matching the CLI default). Backs the main views.
//  - ALL_PROJECTS_KEY    — seeded from ProjectList({ includeArchived: true }) so it
//                          also carries archived projects. Backs the command palette,
//                          which needs archived projects present to surface their
//                          Restore command (archive must not be a one-way trip).
// Both are kept live by the same event fold so they stay consistent in-session.
export const PROJECTS_KEY = ["projects"] as const
export const ALL_PROJECTS_KEY = ["projects", "all"] as const

export const applyEventToCache = (qc: QueryClient, event: DomainEvent): void => {
  qc.setQueryData<ReadonlyArray<Project>>(PROJECTS_KEY, (cur) => foldEvent(cur ?? [], event))
  qc.setQueryData<ReadonlyArray<Project>>(ALL_PROJECTS_KEY, (cur) => foldEvent(cur ?? [], event))
}
