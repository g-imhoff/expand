import { createContext } from "react"
import { Layer, ManagedRuntime } from "effect"
import { NodeServices } from "@effect/platform-node"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import {
  ClientLayer,
  ClientSession,
  resolveBackendCommand,
  type BackendUnavailable
} from "@expand/client-ts"
import { ProjectClient } from "@expand/client-ts/project"
import { ServerClient } from "@expand/client-ts/server"
import { makeNodeAdapter } from "@expand/client-ts/adapters/node"
import { nodeAppContextLayer } from "@expand/tui/node-app-context"

export type ExpandRuntime = ManagedRuntime.ManagedRuntime<
  ClientSession | ProjectClient | ServerClient,
  BackendUnavailable | Layer.Error<typeof nodeAppContextLayer>
>

export const RuntimeContext = createContext<ExpandRuntime | null>(null)

export const makeProductionRuntime = (): ExpandRuntime =>
  ManagedRuntime.make(
    clientLayer(makeNodeAdapter({ backendCommand })).pipe(Layer.provide(NodeServices.layer))
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

const clientLayer = (runtimeAdapter: Parameters<typeof ClientLayer>[0]) =>
  ClientLayer(runtimeAdapter).pipe(Layer.provide(nodeAppContextLayer))
