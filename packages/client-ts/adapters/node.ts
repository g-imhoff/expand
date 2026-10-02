import { NodeChildProcessSpawner, NodePath, NodeSocket } from "@effect/platform-node"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { Effect, Layer } from "effect"
import { Socket } from "effect/socket"
import type { FileSystem } from "effect"
import type { RuntimeAdapter } from "../adapter"
import { BackendUnavailable, type BackendCommandError } from "../errors"
import { spawnResolvedBackend } from "./node-spawn"

export interface NodeAdapterOptions {
  readonly backendCommand: Effect.Effect<
    ReadonlyArray<string>,
    BackendCommandError,
    FileSystem.FileSystem
  >
}

export { nodeProcessControlLayer, ProcessServices } from "./node-process-control"

export const makeNodeAdapter = (opts: NodeAdapterOptions): RuntimeAdapter => {
  const spawnBackend = Effect.fn("NodeAdapter.spawnBackend")(function* spawnBackend(
    dataDir: string
  ) {
    const cmd = yield* resolveCommand(opts.backendCommand)
    yield* spawnResolvedBackend(cmd, dataDir).pipe(
      Effect.scoped,
      Effect.provide(nodeChildProcessSpawnerLayer)
    )
  })
  return { protocolLayer, spawnBackend }
}

const nodeChildProcessSpawnerLayer = NodeChildProcessSpawner.layer.pipe(
  Layer.provide(NodePath.layer)
)

const protocolLayer = (url: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(Socket.layerWebSocket(url).pipe(Layer.provide(NodeSocket.layerWebSocketConstructorWS)))
  )

const resolveCommand = Effect.fn("NodeAdapter.resolveCommand")((
  configured: Effect.Effect<ReadonlyArray<string>, BackendCommandError, FileSystem.FileSystem>
): Effect.Effect<ReadonlyArray<string>, BackendUnavailable, FileSystem.FileSystem> =>
  configured.pipe(
    Effect.mapError((error) => new BackendUnavailable({
      reason: `invalid backend command: ${error.reason}: ${error.detail}`
    }))
  )
)
