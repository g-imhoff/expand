import { Layer, ManagedRuntime } from "effect"
import { NodeServices } from "@effect/platform-node"
import { resolveBackendCommand, type BackendUnavailable } from "@expand/client-ts"
import { ProjectStore, ProjectStoreLayer } from "@expand/client-ts/project"
import { makeNodeAdapter } from "@expand/client-ts/adapters/node"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

export type ExpandRuntime = ManagedRuntime.ManagedRuntime<ProjectStore, BackendUnavailable>

export const defaultBackendEntry = (moduleUrl: string): string =>
  join(fileURLToPath(moduleUrl), "..", "..", "..", "..", "server", "main.ts")

export const makeRuntime = (): ExpandRuntime =>
  ManagedRuntime.make(
    ProjectStoreLayer(makeNodeAdapter({ backendCommand })).pipe(
      Layer.provide(NodeServices.layer)
    )
  )

// Electron's process.execPath is the Electron binary, not a JS runtime, so the
// backend runs under `bun` (execPath) against the absolute source entry. Going
// through source mode (rather than an explicit fallback) keeps the resolver's
// source/compiled existence check and its EXPAND_BACKEND_CMD override.
const backendCommand = (): ReadonlyArray<string> =>
  resolveBackendCommand({ execPath: "bun", sourceEntry: defaultBackendEntry(import.meta.url) })
