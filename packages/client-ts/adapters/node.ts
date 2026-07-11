import { RpcClient, RpcSerialization } from "effect/unstable/rpc"
import { Effect, Layer } from "effect"
import { Socket } from "effect/unstable/socket"
import { WebSocket as WS } from "ws"
import { spawn } from "node:child_process"
import type { RuntimeAdapter } from "../adapter"
import { BackendUnavailable } from "../errors"

// backendCommand is REQUIRED: unlike Bun, there is no safe self-re-invoking
// default here. Under Electron process.execPath is the Electron binary, not a JS
// runtime, so a derived default would silently spawn the wrong thing. Consumers
// (e.g. desktop) pass an explicit command, typically via resolveBackendCommand.
export interface NodeAdapterOptions {
  readonly backendCommand: ReadonlyArray<string> | (() => ReadonlyArray<string>)
}

export const makeNodeAdapter = (opts: NodeAdapterOptions): RuntimeAdapter => {
  const spawnBackend = (dataDir: string) =>
    Effect.flatMap(resolveCommand(opts.backendCommand), (cmd) =>
      Effect.callback<void, BackendUnavailable>((resume) => {
        const [head, ...rest] = cmd
        const args = [...rest, "--data-dir", dataDir]
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

const resolveCommand = (
  configured: ReadonlyArray<string> | (() => ReadonlyArray<string>)
): Effect.Effect<ReadonlyArray<string>, BackendUnavailable> =>
  Effect.try({
    try: () => (typeof configured === "function" ? configured() : configured),
    catch: (e) => new BackendUnavailable({ reason: `invalid backend command: ${String(e)}` })
  })
