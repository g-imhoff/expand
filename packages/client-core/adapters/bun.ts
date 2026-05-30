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

// Default backend command, derived from Bun.main. Compiled binary:
// process.execPath IS yodea -> [execPath, "server"]. Dev from source
// (`bun .../main.ts server`): Bun.main is the real entry -> [bun, entry,
// "server"]. Correct ONLY when this process's entry IS the backend's (the CLI /
// compiled yodea). For a non-CLI frontend (e.g. the Ink TUI) Bun.main is the
// frontend's entry, not the backend's — such callers MUST pass an explicit
// backendCommand instead (mirrors the Node adapter).
const defaultBackendCommand = (): ReadonlyArray<string> => {
  const entry = Bun.main
  const fromSource = existsSync(entry) && /\.(ts|js|mjs|cjs)$/.test(entry)
  return fromSource ? [process.execPath, entry, "server"] : [process.execPath, "server"]
}

export interface BunAdapterOptions {
  // How to launch the backend, e.g. [process.execPath, "<repo>/apps/cli/cli/main.ts",
  // "server"]. When omitted, the command is derived from Bun.main (correct for
  // the CLI and the compiled yodea binary, but NOT for a non-CLI frontend whose
  // Bun.main is its own entry — those must pass this explicitly).
  readonly backendCommand?: ReadonlyArray<string>
}

export const makeBunAdapter = (opts?: BunAdapterOptions): RuntimeAdapter => {
  // Launch `<backend> server` detached (process owns its own lifetime; we unref).
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

// Default adapter: backend command derived from Bun.main. Unchanged behaviour for
// the CLI and all existing imports/tests.
export const bunAdapter: RuntimeAdapter = makeBunAdapter()
