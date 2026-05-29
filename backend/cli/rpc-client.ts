import { RpcClient, RpcClientError, RpcSerialization } from "effect/unstable/rpc"
import { Data, Deferred, Effect, FileSystem, Layer, Stream } from "effect"
import { BunSocket } from "@effect/platform-bun"
import { YodeaRpcs } from "@yodea/shared/rpc"
import { deleteEndpoint, findOrSpawnBackend, type SpawnOptions } from "@yodea/cli/discovery"

// The concrete client `RpcClient.make` resolves to: each method's error channel
// is unioned with `RpcClientError` (transport-level failures). Annotate `use`
// with that exact shape so callers see the real error surface.
export type YodeaClient = RpcClient.FromGroup<typeof YodeaRpcs, RpcClientError.RpcClientError>

// How long we wait to connect AND be registered (the server emits one presence
// `true`) before treating the discovered endpoint as dead. A live server answers
// in milliseconds; a dying server (mid-shutdown) or a dead one never will.
const CONNECT_TIMEOUT = "3 seconds"
// How many times we re-discover-or-spawn after landing on a stale endpoint.
const MAX_ATTEMPTS = 3

// Internal sentinel: the discovered endpoint pointed at a dead/dying server, so
// we could not establish presence in time. Distinct from `use`'s own errors —
// only this triggers stale-file deletion + re-spawn.
class StaleEndpoint extends Data.TaggedError("StaleEndpoint")<{
  readonly reason: string
}> {}

// WebSocket RPC transport for a known backend URL. NDJSON must match the server.
// BunSocket.layerWebSocket bundles the WebSocket constructor (Bun-native), so no
// separate WebSocketConstructor layer is needed.
const protocolLayer = (url: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(BunSocket.layerWebSocket(url))
  )

// Discover-or-spawn the backend, connect, establish the I-4 presence channel,
// wait (bounded) until the server registered us, run `use`, then tear everything
// down (dropping presence -> server may shut down if we were the last connection).
//
// If connecting to a discovered endpoint times out, it landed on a dying/dead
// server (the connect-during-shutdown race): we delete the stale discovery file
// and retry find-or-spawn so the command ultimately spawns a fresh server and
// succeeds instead of hanging. `use`'s own failures are NOT retried.
export const withClient = <A, E, R>(
  options: SpawnOptions,
  use: (client: YodeaClient) => Effect.Effect<A, E, R>
) => {
  const attempt = findOrSpawnBackend(options).pipe(
    Effect.flatMap((endpoint) =>
      Effect.gen(function* () {
        const client = yield* RpcClient.make(YodeaRpcs)
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
        return yield* use(client)
      }).pipe(Effect.scoped, Effect.provide(protocolLayer(endpoint.url)))
    )
  )

  // On a stale endpoint (dying/dead server), delete the discovery file then retry
  // find-or-spawn so the next attempt spawns a FRESH server. Bounded by `times`.
  // `use`'s own errors carry a different tag and are NOT retried.
  return attempt.pipe(
    Effect.tapErrorTag("StaleEndpoint", () => deleteEndpoint),
    Effect.retry({
      times: MAX_ATTEMPTS - 1,
      while: (e) => typeof e === "object" && e !== null && "_tag" in e && e._tag === "StaleEndpoint"
    })
  )
}
