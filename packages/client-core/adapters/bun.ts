import { RpcClient, RpcSerialization } from "effect/unstable/rpc"
import { Effect, Layer } from "effect"
import { BunSocket } from "@effect/platform-bun"
import { existsSync } from "node:fs"
import type { RuntimeAdapter } from "@yodea/client-core/adapter"

// NDJSON-over-WebSocket transport. BunSocket.layerWebSocket bundles Bun's global
// WebSocket, so the result requires nothing.
const protocolLayer = (url: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(BunSocket.layerWebSocket(url))
  )

// Launch `<this program> server` detached. Compiled binary: process.execPath IS
// yodea -> [execPath, "server"]. Dev from source (`bun .../main.ts server`):
// Bun.main is the real entry -> [bun, entry, "server"].
const spawnBackend = Effect.sync(() => {
  const entry = Bun.main
  const fromSource = existsSync(entry) && /\.(ts|js|mjs|cjs)$/.test(entry)
  const cmd = fromSource ? [process.execPath, entry, "server"] : [process.execPath, "server"]
  const child = Bun.spawn({ cmd, stdout: "ignore", stderr: "ignore", stdin: "ignore", env: process.env })
  child.unref()
})

export const bunAdapter: RuntimeAdapter = { protocolLayer, spawnBackend }
