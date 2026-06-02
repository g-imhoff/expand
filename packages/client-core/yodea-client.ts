import { RpcClient, RpcClientError } from "effect/unstable/rpc"
import { Context, Data, Deferred, Effect, Layer, Stream } from "effect"
import type { FileSystem, Scope } from "effect"
import { YodeaRpcs } from "@yodea/contracts/rpc"
import { BackendUnavailable, deleteEndpoint, findOrSpawnBackend } from "@yodea/client-core/discovery"
import type { RuntimeAdapter } from "@yodea/client-core/adapter"

// The concrete client surface: every RPC method, with each error channel unioned
// with `RpcClientError` (transport-level failures). This is the service Shape.
export type YodeaClientApi = RpcClient.FromGroup<typeof YodeaRpcs, RpcClientError.RpcClientError>

// Context service tag. No `make` here — the real implementation is always
// supplied by `YodeaClientLive(adapter)` (the URL is only known at runtime, so
// the transport can't be a static layer dependency). Mirrors ProjectStore.
export class YodeaClient extends Context.Service<YodeaClient, YodeaClientApi>()(
  "yodea/YodeaClient"
) {}

// How long we wait to connect AND be registered (the server emits one presence
// `true`) before treating the discovered endpoint as dead. A live server answers
// in milliseconds; a dying server (mid-shutdown) or a dead one never will.
const CONNECT_TIMEOUT = "3 seconds"
// How many times we re-discover-or-spawn after landing on a stale endpoint.
const MAX_ATTEMPTS = 3

// Internal sentinel: the discovered endpoint pointed at a dead/dying server, so
// we could not establish presence in time. Distinct from a caller's own errors —
// only this triggers stale-file deletion + re-spawn.
class StaleEndpoint extends Data.TaggedError("StaleEndpoint")<{
  readonly reason: string
}> {}

// Acquire a connected client on the AMBIENT (layer) scope: discover-or-spawn the
// backend, connect, establish the I-4 presence channel held for the whole scope,
// and wait (bounded) until the server registered us. The presence fiber and
// transport live until the layer scope closes (dropping presence -> the server
// may shut down if we were the last connection).
//
// If connecting to a discovered endpoint times out, it landed on a dying/dead
// server (the connect-during-shutdown race): we delete the stale discovery file
// and retry find-or-spawn so the layer ultimately connects to a fresh server. A
// terminal StaleEndpoint (retries exhausted) surfaces as BackendUnavailable — the
// CLI maps it to exit 6 — rather than a defect.
const acquire = (
  adapter: RuntimeAdapter
): Effect.Effect<YodeaClientApi, BackendUnavailable, FileSystem.FileSystem | Scope.Scope> => {
  const once = findOrSpawnBackend(adapter).pipe(
    // `findOrSpawnBackend` leaks the internal `"pending"` retry sentinel in its
    // error TYPE only — `awaitEndpoint` retries it forever, so it can never
    // actually escape. Discharge it as a defect to keep this layer's error
    // channel to the real failure: BackendUnavailable.
    Effect.catchIf(
      (e): e is "pending" => e === "pending",
      (e) => Effect.die(e)
    ),
    Effect.flatMap((endpoint) =>
      Effect.gen(function* () {
        // Build the transport onto the AMBIENT (layer) scope so the WebSocket
        // connection outlives this gen and lives until the layer is disposed.
        // `Effect.provide` would build it into a sub-scope that closes the moment
        // the gen returns, tearing down the connection before any caller uses it.
        const protocol = yield* Layer.build(adapter.protocolLayer(endpoint.url))
        const client = yield* RpcClient.make(YodeaRpcs).pipe(Effect.provideContext(protocol))
        const ready = yield* Deferred.make<void>()
        // Hold the presence subscription for the whole scope; resolve `ready`
        // on the first `true` so we never disconnect before being registered.
        yield* Effect.forkScoped(
          Stream.runDrain(
            Stream.tap(client.Connect(), () => Deferred.succeed(ready, undefined))
          )
        )
        // Bound the connect + readiness wait. A dying/dead server never sends the
        // presence marker, so `ready` never resolves -> we time out and treat the
        // endpoint as stale (the forked stream is interrupted when the scope closes).
        yield* Deferred.await(ready).pipe(
          Effect.timeoutOrElse({
            duration: CONNECT_TIMEOUT,
            orElse: () =>
              Effect.fail(
                new StaleEndpoint({ reason: `no presence from ${endpoint.url} within ${CONNECT_TIMEOUT}` })
              )
          })
        )
        return client
      })
    )
  )

  return once.pipe(
    // On a stale endpoint (dying/dead server), delete the discovery file then
    // retry find-or-spawn so the next attempt spawns/discovers a FRESH server.
    Effect.tapErrorTag("StaleEndpoint", () => deleteEndpoint),
    Effect.retry({
      times: MAX_ATTEMPTS - 1,
      while: (e) =>
        typeof e === "object" && e !== null && "_tag" in e && (e as { _tag: string })._tag === "StaleEndpoint"
    }),
    // After retries are exhausted, a terminal StaleEndpoint becomes
    // BackendUnavailable (CLI exit 6) — do NOT die.
    Effect.catchTag("StaleEndpoint", (e) => Effect.fail(new BackendUnavailable({ reason: e.reason })))
  )
}

// Parameterized scoped layer: the adapter is captured in closure (URL is only
// known at runtime). `Layer.effect` runs `acquire` in the layer's own scope (it
// supplies + discharges `Scope.Scope`), so the presence fiber and transport are
// held for the layer's lifetime and torn down on close — mirroring ProjectStore.
export const YodeaClientLive = (
  adapter: RuntimeAdapter
): Layer.Layer<YodeaClient, BackendUnavailable, FileSystem.FileSystem> =>
  Layer.effect(YodeaClient, acquire(adapter))
