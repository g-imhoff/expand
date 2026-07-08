import { Layer, ManagedRuntime } from "effect"
import { NodeServices } from "@effect/platform-node"
import { ProjectStore, resolveBackendCommand, type BackendUnavailable } from "@expand/client-ts"
import { ProjectStoreLayer } from "@expand/client-ts"
import { makeNodeAdapter } from "@expand/client-ts/adapters/node"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

export type ExpandRuntime = ManagedRuntime.ManagedRuntime<ProjectStore, BackendUnavailable>

export const defaultBackendEntry = (moduleUrl: string): string =>
  join(fileURLToPath(moduleUrl), "..", "..", "..", "..", "server", "main.ts")

// Electron's process.execPath is the Electron binary, not a JS runtime, so the
// backend is spawned via `bun` explicitly (binaryArgs) rather than source mode.
const backendCommand = (): ReadonlyArray<string> =>
  resolveBackendCommand({ binaryArgs: ["bun", defaultBackendEntry(import.meta.url)] })

export const makeRuntime = (): ExpandRuntime =>
  ManagedRuntime.make(
    ProjectStoreLayer(makeNodeAdapter({ backendCommand })).pipe(
      Layer.provide(NodeServices.layer)
    )
  )
