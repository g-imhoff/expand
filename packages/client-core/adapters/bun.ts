import { RpcClient, RpcSerialization } from "effect/unstable/rpc"
import { Effect, Layer } from "effect"
import { BunSocket } from "@effect/platform-bun"
import { existsSync } from "node:fs"
import type { RuntimeAdapter } from "@yodea/client-core/adapter"

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
  readonly backendCommand?: ReadonlyArray<string>
}

export const makeBunAdapter = (opts?: BunAdapterOptions): RuntimeAdapter => {
  const spawnBackend = Effect.sync(() => {
    const [cmd, ...args] = opts?.backendCommand ?? defaultBackendCommand()
    const child = Bun.spawn({
      cmd: [cmd!, ...args],
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
      env: process.env
    })
    child.unref()
  })
  return { protocolLayer, spawnBackend }
}

export const bunAdapter: RuntimeAdapter = makeBunAdapter()
