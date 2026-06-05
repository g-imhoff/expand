import { RpcClient, RpcSerialization } from "effect/unstable/rpc"
import { Effect, Layer } from "effect"
import { Socket } from "effect/unstable/socket"
import { WebSocket as WS } from "ws"
import { spawn } from "node:child_process"
import type { RuntimeAdapter } from "@yodea/client-core/adapter"

const wsConstructor = Layer.succeed(
  Socket.WebSocketConstructor,
  (url: string, protocols?: string | ReadonlyArray<string>) =>
    new WS(url, protocols as string | Array<string> | undefined) as unknown as globalThis.WebSocket
)

const protocolLayer = (url: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(Socket.layerWebSocket(url).pipe(Layer.provide(wsConstructor)))
  )

export interface NodeAdapterOptions {
  readonly backendCommand: ReadonlyArray<string>
}

export const makeNodeAdapter = (opts: NodeAdapterOptions): RuntimeAdapter => {
  const spawnBackend = Effect.sync(() => {
    const [cmd, ...args] = opts.backendCommand
    const child = spawn(cmd!, args, { detached: true, stdio: "ignore", env: process.env })
    child.unref()
  })
  return { protocolLayer, spawnBackend }
}
