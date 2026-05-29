import { RpcClient, RpcClientError, RpcSerialization } from "effect/unstable/rpc"
import { Deferred, Effect, Layer, Stream } from "effect"
import { BunSocket } from "@effect/platform-bun"
import { YodeaRpcs } from "@yodea/shared/rpc"
import { findOrSpawnBackend, type SpawnOptions } from "@yodea/cli/discovery"

// The concrete client `RpcClient.make` resolves to: each method's error channel
// is unioned with `RpcClientError` (transport-level failures). Annotate `use`
// with that exact shape so callers see the real error surface.
export type YodeaClient = RpcClient.FromGroup<typeof YodeaRpcs, RpcClientError.RpcClientError>

// WebSocket RPC transport for a known backend URL. NDJSON must match the server.
// BunSocket.layerWebSocket bundles the WebSocket constructor (Bun-native), so no
// separate WebSocketConstructor layer is needed.
const protocolLayer = (url: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(BunSocket.layerWebSocket(url))
  )

// Discover-or-spawn the backend, connect, establish the I-4 presence channel,
// wait until the server registered us, run `use`, then tear everything down
// (dropping presence -> server may shut down if we were the last connection).
export const withClient = <A, E, R>(
  options: SpawnOptions,
  use: (client: YodeaClient) => Effect.Effect<A, E, R>
) =>
  findOrSpawnBackend(options).pipe(
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
        yield* Deferred.await(ready)
        return yield* use(client)
      }).pipe(Effect.scoped, Effect.provide(protocolLayer(endpoint.url)))
    )
  )
