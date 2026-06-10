import { RpcClient, RpcSerialization } from "effect/unstable/rpc"
import { Effect, Layer } from "effect"
import { Socket } from "effect/unstable/socket"
import { WebSocket as WS } from "ws"
import { spawn } from "node:child_process"
import type { RuntimeAdapter } from "@yodea/client-core/adapter"
import { BackendUnavailable } from "@yodea/client-core/discovery"

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
  readonly backendCommand: ReadonlyArray<string> | (() => ReadonlyArray<string>)
}

const resolveCommand = (
  configured: ReadonlyArray<string> | (() => ReadonlyArray<string>)
): Effect.Effect<ReadonlyArray<string>, BackendUnavailable> =>
  Effect.try({
    try: () => (typeof configured === "function" ? configured() : configured),
    catch: (e) => new BackendUnavailable({ reason: `invalid backend command: ${String(e)}` })
  })

export const makeNodeAdapter = (opts: NodeAdapterOptions): RuntimeAdapter => {
  const spawnBackend = Effect.flatMap(resolveCommand(opts.backendCommand), (cmd) =>
    Effect.callback<void, BackendUnavailable>((resume) => {
      const [head, ...args] = cmd
      const child = spawn(head!, args, { detached: true, stdio: "ignore", env: process.env })
      child.once("error", (e) => {
        resume(Effect.fail(new BackendUnavailable({ reason: `spawn failed: ${cmd.join(" ")}: ${String(e)}` })))
      })
      child.once("spawn", () => {
        child.unref()
        resume(Effect.void)
      })
    })
  )
  return { protocolLayer, spawnBackend }
}
