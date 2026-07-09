import { createContext } from "react"
import { Layer, ManagedRuntime } from "effect"
import { BunServices } from "@effect/platform-bun"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { resolveBackendCommand, type BackendUnavailable } from "@expand/client-ts"
import { ProjectStore, ProjectStoreLayer } from "@expand/client-ts/project"
import { makeBunAdapter } from "@expand/client-ts/adapters/bun"

export type ExpandRuntime = ManagedRuntime.ManagedRuntime<ProjectStore, BackendUnavailable>

export const RuntimeContext = createContext<ExpandRuntime | null>(null)

// From source (apps/tui/runtime.ts) the sibling apps/server/main.ts entry runs
// under the current Bun runtime: `bun apps/server/main.ts`.
const backendCommand = (): ReadonlyArray<string> =>
  resolveBackendCommand({ sourceEntry: join(fileURLToPath(import.meta.url), "..", "..", "server", "main.ts") })

export const makeProductionRuntime = (): ExpandRuntime =>
  ManagedRuntime.make(
    ProjectStoreLayer(makeBunAdapter({ backendCommand })).pipe(
      Layer.provide(BunServices.layer)
    )
  )
