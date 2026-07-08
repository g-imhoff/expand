import { RpcClient, RpcSerialization } from "effect/unstable/rpc"
import { Effect, Layer } from "effect"
import { Socket } from "effect/unstable/socket"
import { WebSocket as WS } from "ws"
import { spawn } from "node:child_process"
import type { RuntimeAdapter } from "@expand/client-ts/adapter"
import { BackendUnavailable } from "@expand/client-ts/errors"
import { resolveBackendCommand } from "@expand/client-ts/backend-command"

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

// Robust default (symmetric with the Bun adapter): honour EXPAND_BACKEND_CMD,
// else re-invoke the current runtime against the main module with a `server`
// subcommand. Node/Electron consumers (e.g. desktop) normally pass an explicit
// backendCommand since process.execPath is not a JS runtime under Electron.
const defaultBackendCommand = (): ReadonlyArray<string> =>
  resolveBackendCommand({ sourceEntry: process.argv[1], sourceArgs: ["server"], binaryArgs: [process.execPath, "server"] })

export interface NodeAdapterOptions {
  readonly backendCommand?: ReadonlyArray<string> | (() => ReadonlyArray<string>)
}

const resolveCommand = (
  configured: ReadonlyArray<string> | (() => ReadonlyArray<string>) | undefined
): Effect.Effect<ReadonlyArray<string>, BackendUnavailable> =>
  Effect.try({
    try: () => (typeof configured === "function" ? configured() : configured ?? defaultBackendCommand()),
    catch: (e) => new BackendUnavailable({ reason: `invalid backend command: ${String(e)}` })
  })

export const makeNodeAdapter = (opts?: NodeAdapterOptions): RuntimeAdapter => {
  const spawnBackend = (dataDir: string) =>
    Effect.flatMap(resolveCommand(opts?.backendCommand), (cmd) =>
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
