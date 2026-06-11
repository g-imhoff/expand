import { RpcClient, RpcSerialization } from "effect/unstable/rpc"
import { Effect, Layer } from "effect"
import { BunSocket } from "@effect/platform-bun"
import { existsSync } from "node:fs"
import type { RuntimeAdapter } from "@yodea/client-core/adapter"
import { BackendUnavailable } from "@yodea/client-core/discovery"

const protocolLayer = (url: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(BunSocket.layerWebSocket(url))
  )

const defaultBackendCommand = (): ReadonlyArray<string> => {
  const entry = Bun.main
  const fromSource = existsSync(entry) && /\.(ts|js|mjs|cjs)$/.test(entry)
  return fromSource ? [process.execPath, entry, "server"] : [process.execPath, "server"]
}

export interface BunAdapterOptions {
  readonly backendCommand?: ReadonlyArray<string> | (() => ReadonlyArray<string>)
}

const resolveCommand = (
  configured: ReadonlyArray<string> | (() => ReadonlyArray<string>) | undefined
): Effect.Effect<ReadonlyArray<string>, BackendUnavailable> =>
  Effect.try({
    try: () => (typeof configured === "function" ? configured() : configured ?? defaultBackendCommand()),
    catch: (e) => new BackendUnavailable({ reason: `invalid backend command: ${String(e)}` })
  })

export const makeBunAdapter = (opts?: BunAdapterOptions): RuntimeAdapter => {
  const spawnBackend = Effect.flatMap(resolveCommand(opts?.backendCommand), (cmd) =>
    Effect.try({
      try: () => {
        const [head, ...args] = cmd
        const child = Bun.spawn({
          cmd: [head!, ...args],
          stdout: "ignore",
          stderr: "ignore",
          stdin: "ignore",
          env: process.env
        })
        child.unref()
      },
      catch: (e) => new BackendUnavailable({ reason: `spawn failed: ${cmd.join(" ")}: ${String(e)}` })
    })
  )
  return { protocolLayer, spawnBackend }
}

export const bunAdapter: RuntimeAdapter = makeBunAdapter()
