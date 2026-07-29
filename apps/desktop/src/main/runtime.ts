import { NodePath } from "@effect/platform-node"
import { Effect, Layer, ManagedRuntime, Path } from "effect"
import { ProcessServices } from "@expand/client-ts/adapters/node"
import {
  ClientLayer,
  ClientSession,
  resolveBackendCommand,
  type BackendUnavailable
} from "@expand/client-ts"
import { ProjectClient } from "@expand/client-ts/project"
import { ServerClient } from "@expand/client-ts/server"
import { makeNodeAdapter } from "@expand/client-ts/adapters/node"
import { nodeAppContextLayer } from "@expand/desktop/main/node-app-context"

export type ExpandRuntime = ManagedRuntime.ManagedRuntime<
  ClientSession | ProjectClient | ServerClient,
  BackendUnavailable | Layer.Error<typeof nodeAppContextLayer>
>

export const defaultBackendEntry = Effect.fn("DesktopMain.defaultBackendEntry")(function* (
  moduleUrl: URL
) {
  const path = yield* Path.Path
  const modulePath = yield* path.fromFileUrl(moduleUrl)
  return path.join(modulePath, "..", "..", "..", "..", "server", "main.ts")
})

export const makeRuntime = (): ExpandRuntime =>
  ManagedRuntime.make(
    clientLayer(makeNodeAdapter({ backendCommand })).pipe(Layer.provide(ProcessServices.layer))
  )

const backendCommand = defaultBackendEntry(new URL(import.meta.url)).pipe(
  Effect.orDie,
  Effect.provide(NodePath.layer),
  Effect.flatMap((sourceEntry) =>
    resolveBackendCommand({
      execPath: "node",
      runtimeArgs: ["--import", "tsx"],
      sourceEntry
    })
  )
)

const clientLayer = (runtimeAdapter: Parameters<typeof ClientLayer>[0]) =>
  ClientLayer(runtimeAdapter).pipe(Layer.provide(nodeAppContextLayer))
