import { Effect, SubscriptionRef } from "effect"
import { ProjectStore } from "@yodea/client-core"
import type { Project } from "@yodea/contracts/project"
import { useStoreSubscription } from "@yodea/tui/hooks/use-store-subscription"

// Module-level constant -> stable reference for the bridge's effect deps.
const projectsRef: Effect.Effect<SubscriptionRef.SubscriptionRef<ReadonlyArray<Project>>, never, ProjectStore> =
  Effect.map(ProjectStore, (store) => store.projects)

export type ProjectsState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly projects: ReadonlyArray<Project> }
  | { readonly status: "error"; readonly message: string }

export const useProjects = (): ProjectsState => {
  const sub = useStoreSubscription(projectsRef, [] as ReadonlyArray<Project>)
  if (sub.status === "loading") return { status: "loading" }
  if (sub.status === "error") return { status: "error", message: sub.error ?? "Unknown error" }
  return { status: "ready", projects: sub.value }
}
