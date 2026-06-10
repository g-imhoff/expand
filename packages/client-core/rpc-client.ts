import { RpcClient, RpcClientError } from "effect/unstable/rpc"
import { Context, Data, Deferred, Effect, Layer, Stream } from "effect"
import type { FileSystem, Scope } from "effect"
import { YodeaRpcs } from "@yodea/contracts/rpc"
import type { Endpoint } from "@yodea/contracts/endpoint"
import { BackendUnavailable, deleteEndpoint, findOrSpawnBackend } from "@yodea/client-core/discovery"
import { supervised } from "@yodea/client-core/supervise"
import type { RuntimeAdapter } from "@yodea/client-core/adapter"

export type YodeaRpcClientApi = RpcClient.FromGroup<typeof YodeaRpcs, RpcClientError.RpcClientError>

export class YodeaRpcClient extends Context.Service<YodeaRpcClient, YodeaRpcClientApi>()(
  "yodea/YodeaRpcClient"
) {}

export const endpointWsUrl = (endpoint: Endpoint): string =>
  `${endpoint.url}?token=${encodeURIComponent(endpoint.token)}`

const CONNECT_TIMEOUT = "3 seconds"
const MAX_ATTEMPTS = 3

class StaleEndpoint extends Data.TaggedError("StaleEndpoint")<{
  readonly reason: string
}> {}

const acquire = (
  adapter: RuntimeAdapter
): Effect.Effect<YodeaRpcClientApi, BackendUnavailable, FileSystem.FileSystem | Scope.Scope> => {
  const once = findOrSpawnBackend(adapter).pipe(
    Effect.catchIf(
      (e): e is "pending" => e === "pending",
      (e) => Effect.die(e)
    ),
    Effect.flatMap((endpoint) =>
      Effect.gen(function* () {
        const protocol = yield* Layer.build(adapter.protocolLayer(endpointWsUrl(endpoint)))
        const client = yield* RpcClient.make(YodeaRpcs).pipe(Effect.provideContext(protocol))
        const ready = yield* Deferred.make<void>()
        yield* Effect.forkScoped(
          supervised(
            "rpc-client connect drain",
            Stream.runDrain(
              Stream.tap(client.Connect(), () => Deferred.succeed(ready, undefined))
            )
          )
        )
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
    Effect.tapErrorTag("StaleEndpoint", () => deleteEndpoint),
    Effect.retry({
      times: MAX_ATTEMPTS - 1,
      while: (e) =>
        typeof e === "object" && e !== null && "_tag" in e && (e as { _tag: string })._tag === "StaleEndpoint"
    }),
    Effect.catchTag("StaleEndpoint", (e) => Effect.fail(new BackendUnavailable({ reason: e.reason })))
  )
}

export const YodeaRpcClientLive = (
  adapter: RuntimeAdapter
): Layer.Layer<YodeaRpcClient, BackendUnavailable, FileSystem.FileSystem> =>
  Layer.effect(YodeaRpcClient, acquire(adapter))
