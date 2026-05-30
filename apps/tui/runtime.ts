import { createContext } from "react"
import { Layer, ManagedRuntime } from "effect"
import { BunServices } from "@effect/platform-bun"
import { ProjectStore } from "@yodea/client-core"
import { ProjectStoreLayer } from "@yodea/client-core/project-store"
import { bunAdapter } from "@yodea/client-core/adapters/bun"

export type YodeaRuntime = ManagedRuntime.ManagedRuntime<ProjectStore, never>

// Provided via React context so tests can inject a fake-store runtime.
export const RuntimeContext = createContext<YodeaRuntime | null>(null)

export const makeProductionRuntime = (): YodeaRuntime =>
  ManagedRuntime.make(ProjectStoreLayer(bunAdapter).pipe(Layer.provide(BunServices.layer)))
