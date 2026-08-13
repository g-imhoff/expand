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
import { nodeAppContextLayer } from "@expand/desktop/main/runtime/node-app-context"

export interface DesktopBackendHost {
  readonly backendEntry: string
  readonly isPackaged: boolean
  readonly moduleUrl: URL
  readonly awaitPackagedBackendShutdown: Effect.Effect<void>
  readonly spawnPackagedBackend: (
    backendEntry: string,
    dataDir: string
  ) => Effect.Effect<void, BackendUnavailable>
}

export type ExpandRuntime = ManagedRuntime.ManagedRuntime<
  ClientSession | ProjectClient | ServerClient,
  BackendUnavailable | Layer.Error<typeof nodeAppContextLayer>
>

export const defaultBackendEntry = Effect.fn("DesktopMain.defaultBackendEntry")(function* (
  moduleUrl: URL
) {
  const path = yield* Path.Path
  const modulePath = yield* path.fromFileUrl(moduleUrl)
  const sourceOffset = modulePath.endsWith(".ts") ? ".." : "."
  return path.join(modulePath, "..", "..", "..", "..", sourceOffset, "server", "main.ts")
})

export const defaultBackendAdapter = (host: DesktopBackendHost) => {
  const nodeAdapter = makeNodeAdapter({
    backendCommand: defaultBackendEntry(host.moduleUrl).pipe(
      Effect.orDie,
      Effect.provide(NodePath.layer),
      Effect.flatMap((sourceEntry) => resolveBackendCommand({
        execPath: "node",
        runtimeArgs: ["--import", "tsx"],
        sourceEntry
      }))
    )
  })
  return host.isPackaged
    ? {
      protocolLayer: nodeAdapter.protocolLayer,
      spawnBackend: (dataDir: string) => host.spawnPackagedBackend(host.backendEntry, dataDir)
    }
    : nodeAdapter
}

export const makeRuntime = (host: DesktopBackendHost): ExpandRuntime => {
  const runtime = ManagedRuntime.make(
    clientLayer(defaultBackendAdapter(host)).pipe(Layer.provide(ProcessServices.layer))
  )
  if (!host.isPackaged) return runtime
  const disposeEffect = runtime.disposeEffect
  return Object.assign(runtime, {
    disposeEffect: disposeEffect.pipe(Effect.andThen(host.awaitPackagedBackendShutdown))
  })
}

const clientLayer = (runtimeAdapter: Parameters<typeof ClientLayer>[0]) =>
  ClientLayer(runtimeAdapter).pipe(Layer.provide(nodeAppContextLayer))
