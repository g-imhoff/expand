import { createContext } from "react"
import { Layer, ManagedRuntime } from "effect"
import { NodeServices } from "@effect/platform-node"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { resolveBackendCommand, type BackendUnavailable } from "@expand/client-ts"
import { ProjectStore, ProjectStoreLayer } from "@expand/client-ts/project"
import { makeNodeAdapter } from "@expand/client-ts/adapters/node"

export type ExpandRuntime = ManagedRuntime.ManagedRuntime<ProjectStore, BackendUnavailable>

export const RuntimeContext = createContext<ExpandRuntime | null>(null)

export const makeProductionRuntime = (): ExpandRuntime =>
  ManagedRuntime.make(
    ProjectStoreLayer(makeNodeAdapter({ backendCommand })).pipe(
      Layer.provide(NodeServices.layer)
    )
  )

const backendCommand = (): ReadonlyArray<string> => {
  const sourceEntry = join(fileURLToPath(import.meta.url), "..", "..", "server", "main.ts")
  return resolveBackendCommand({
    execPath: process.execPath,
    runtimeArgs: ["--import", "tsx"],
    sourceEntry,
    binaryArgs: [process.execPath, join(dirname(fileURLToPath(import.meta.url)), "expand-server")]
  })
}
