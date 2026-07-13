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

const backendCommand = (): ReadonlyArray<string> =>
  resolveBackendCommand({
    execPath: "node",
    runtimeArgs: ["--import", "tsx"],
    sourceEntry: defaultBackendEntry(import.meta.url)
  })
