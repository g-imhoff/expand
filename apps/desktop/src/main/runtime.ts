import { Layer, ManagedRuntime } from "effect"
import { NodeServices } from "@effect/platform-node"
import {
  ClientLayer,
  ClientSession,
  resolveBackendCommand,
  type BackendUnavailable
} from "@expand/client-ts"
import { ProjectClient } from "@expand/client-ts/project"
import { ServerClient } from "@expand/client-ts/server"
import { makeNodeAdapter } from "@expand/client-ts/adapters/node"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { nodeAppContextLayer } from "@expand/desktop/main/node-app-context"

export type ExpandRuntime = ManagedRuntime.ManagedRuntime<
  ClientSession | ProjectClient | ServerClient,
  BackendUnavailable | Layer.Error<typeof nodeAppContextLayer>
>

export const defaultBackendEntry = (moduleUrl: string): string =>
  join(fileURLToPath(moduleUrl), "..", "..", "..", "..", "server", "main.ts")

export const makeRuntime = (): ExpandRuntime =>
  ManagedRuntime.make(
    clientLayer(makeNodeAdapter({ backendCommand })).pipe(Layer.provide(NodeServices.layer))
  )

const backendCommand = Effect.suspend(() =>
  resolveBackendCommand({
    execPath: "node",
    runtimeArgs: ["--import", "tsx"],
    sourceEntry: defaultBackendEntry(import.meta.url)
  }))

const clientLayer = (runtimeAdapter: Parameters<typeof ClientLayer>[0]) =>
  ClientLayer(runtimeAdapter).pipe(Layer.provide(nodeAppContextLayer))
