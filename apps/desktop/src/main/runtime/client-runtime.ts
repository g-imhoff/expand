import { NodePath } from "@effect/platform-node"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname as dirnameNode, join as joinNode, resolve as resolveNode } from "node:path"
import { Effect, Layer, ManagedRuntime, Path, Schema } from "effect"
import { ProcessServices } from "@expand/client-ts/adapters/node"
import {
  ClientLayer,
  ClientSession,
  resolveBackendCommand,
  remoteSpawnGuard,
  type BackendUnavailable,
  type RuntimeAdapter
} from "@expand/client-ts"
import type { BackendConnection } from "@expand/contracts/backend-connection"
import { BackendConnectionFromJson } from "@expand/contracts/backend-connection"
import { dataDirFromArgs, makeAppContext } from "@expand/contracts/app-context"
import { AutomationClient } from "@expand/client-ts/automation"
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
  ClientSession | ProjectClient | ServerClient | AutomationClient,
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

export const defaultBackendAdapter = (
  host: DesktopBackendHost,
  connection?: BackendConnection
): RuntimeAdapter => {
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
  if (connection !== undefined && connection._tag === "remote") {
    return {
      protocolLayer: nodeAdapter.protocolLayer,
      spawnBackend: () => Effect.fail(remoteSpawnGuard())
    }
  }
  return host.isPackaged
    ? {
      protocolLayer: nodeAdapter.protocolLayer,
      spawnBackend: (dataDir: string) => host.spawnPackagedBackend(host.backendEntry, dataDir)
    }
    : nodeAdapter
}

export const makeRuntime = (host: DesktopBackendHost, connection?: BackendConnection): ExpandRuntime => {
  const effective = connection ?? loadPersistedConnectionSync()
  const runtime = ManagedRuntime.make(
    clientLayer(defaultBackendAdapter(host, effective), effective).pipe(Layer.provide(ProcessServices.layer))
  )
  if (!host.isPackaged) return runtime
  const disposeEffect = runtime.disposeEffect
  return Object.assign(runtime, {
    disposeEffect: disposeEffect.pipe(Effect.andThen(host.awaitPackagedBackendShutdown))
  })
}

const loadPersistedConnectionSync = (): BackendConnection => {
  try {
    const homeDir = homedir()
    const cwd = process.cwd()
    const dataDir = dataDirFromArgs(process.argv)
    const context = makeAppContext(
      { join: joinNode, resolve: resolveNode },
      { homeDir, cwd, ...(dataDir === undefined ? {} : { dataDir }) }
    )
    const file = joinNode(dirnameNode(context.paths.endpointFile), "remote-backend.json")
    if (!existsSync(file)) return { _tag: "local" }
    const text = readFileSync(file, "utf8")
    return Schema.decodeUnknownSync(BackendConnectionFromJson)(text)
  } catch {
    return { _tag: "local" }
  }
}

const clientLayer = (
  runtimeAdapter: Parameters<typeof ClientLayer>[0],
  connection?: BackendConnection
) =>
  ClientLayer(runtimeAdapter, connection).pipe(Layer.provide(nodeAppContextLayer))
