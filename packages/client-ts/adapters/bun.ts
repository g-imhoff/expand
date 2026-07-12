import { RpcClient, RpcSerialization } from "effect/unstable/rpc"
import { Effect, Layer } from "effect"
import { BunSocket } from "@effect/platform-bun"
import type { RuntimeAdapter } from "../adapter"
import { BackendUnavailable } from "../errors"
import { resolveBackendCommand } from "../backend-command"

export interface BunAdapterOptions {
  readonly backendCommand?: ReadonlyArray<string> | (() => ReadonlyArray<string>)
}

export const makeBunAdapter = (opts?: BunAdapterOptions): RuntimeAdapter => {
  const spawnBackend = (dataDir: string) =>
    Effect.flatMap(resolveCommand(opts?.backendCommand), (cmd) =>
      Effect.try({
        try: () => {
          const [head, ...rest] = cmd
          const child = Bun.spawn({
            cmd: [head!, ...rest, "--data-dir", dataDir],
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

/**
 * Convenience Bun adapter using {@link defaultBackendCommand} (env override →
 * `<runtime> <entry> server`). Frontends normally build their own adapter via
 * {@link makeBunAdapter} with an explicit `backendCommand` (see
 * `resolveBackendCommand`); this singleton is for callers — chiefly the
 * integration suite and benches — that either connect to an already-running
 * backend or accept the self-re-invoking default.
 */
export const bunAdapter: RuntimeAdapter = makeBunAdapter()

function protocolLayer(url: string) {
  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(BunSocket.layerWebSocket(url))
  )
}

// Robust default (symmetric with the Node adapter): honour EXPAND_BACKEND_CMD,
// else re-invoke this binary against its own entrypoint with a `server`
// subcommand — from source `bun <Bun.main> server`, once compiled `<self> server`.
const defaultBackendCommand = (): ReadonlyArray<string> =>
  resolveBackendCommand({ sourceEntry: Bun.main, sourceArgs: ["server"], binaryArgs: [process.execPath, "server"] })

const resolveCommand = (
  configured: ReadonlyArray<string> | (() => ReadonlyArray<string>) | undefined
): Effect.Effect<ReadonlyArray<string>, BackendUnavailable> =>
  Effect.try({
    try: () => (typeof configured === "function" ? configured() : configured ?? defaultBackendCommand()),
    catch: (e) => new BackendUnavailable({ reason: `invalid backend command: ${String(e)}` })
  })
