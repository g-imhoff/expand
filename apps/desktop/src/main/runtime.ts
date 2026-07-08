import { Layer, ManagedRuntime } from "effect"
import { NodeServices } from "@effect/platform-node"
import { ProjectStore, type BackendUnavailable } from "@expand/client-ts"
import { ProjectStoreLayer } from "@expand/client-ts/project-store"
import { makeNodeAdapter } from "@expand/client-ts/adapters/node"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

export type ExpandRuntime = ManagedRuntime.ManagedRuntime<ProjectStore, BackendUnavailable>

export const defaultBackendEntry = (moduleUrl: string): string =>
  join(fileURLToPath(moduleUrl), "..", "..", "..", "..", "server", "main.ts")

const backendCommand = (): ReadonlyArray<string> => {
  const override = process.env.EXPAND_BACKEND_CMD
  if (override) {
    const parsed = JSON.parse(override) as ReadonlyArray<string>
    if (!Array.isArray(parsed) || parsed.some((s) => typeof s !== "string")) {
      throw new Error("EXPAND_BACKEND_CMD must be a JSON array of strings")
    }
    return parsed
  }
  return ["bun", defaultBackendEntry(import.meta.url)]
}

export const makeRuntime = (): ExpandRuntime =>
  ManagedRuntime.make(
    ProjectStoreLayer(makeNodeAdapter({ backendCommand })).pipe(
      Layer.provide(NodeServices.layer)
    )
  )
