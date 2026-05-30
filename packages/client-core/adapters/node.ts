import { RpcClient, RpcSerialization } from "effect/unstable/rpc"
import { Effect, Layer } from "effect"
import { Socket } from "effect/unstable/socket"
import { WebSocket as WS } from "ws"
import { spawn } from "node:child_process"
import type { RuntimeAdapter } from "@yodea/client-core/adapter"

// Node has no global WebSocket: provide the constructor from the `ws` package.
// The ws WebSocket is wire-compatible with the browser WebSocket the Socket layer
// expects; the cast bridges the slightly-different TS types.
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
  // How to launch the backend. Dev: ["bun", "<repo>/apps/cli/cli/main.ts", "server"].
  // Packaged: [pathToCompiledYodea, "server"].
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
