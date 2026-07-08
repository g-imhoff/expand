import { createContext } from "react"
import { Layer, ManagedRuntime } from "effect"
import { BunServices } from "@effect/platform-bun"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { ProjectStore, type BackendUnavailable } from "@expand/client-ts"
import { ProjectStoreLayer } from "@expand/client-ts"
import { makeBunAdapter } from "@expand/client-ts/adapters/bun"

export type ExpandRuntime = ManagedRuntime.ManagedRuntime<ProjectStore, BackendUnavailable>

export const RuntimeContext = createContext<ExpandRuntime | null>(null)

const resolveBackendCommand = (): ReadonlyArray<string> => {
  const override = process.env.EXPAND_BACKEND_CMD
  if (override) {
    const parsed = JSON.parse(override) as ReadonlyArray<string>
    if (!Array.isArray(parsed) || parsed.some((s) => typeof s !== "string")) {
      throw new Error("EXPAND_BACKEND_CMD must be a JSON array of strings")
    }
    return parsed
  }
  const here = fileURLToPath(import.meta.url)
  const backendEntry = join(here, "..", "..", "server", "main.ts")
  return [process.execPath, backendEntry]
}

export const makeProductionRuntime = (): ExpandRuntime =>
  ManagedRuntime.make(
    ProjectStoreLayer(makeBunAdapter({ backendCommand: resolveBackendCommand })).pipe(
      Layer.provide(BunServices.layer)
    )
  )
