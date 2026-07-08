import { RpcClient, RpcClientError } from "effect/unstable/rpc"
import { Context, Data, Deferred, Effect, Layer, Stream } from "effect"
import type { FileSystem, Scope } from "effect"
import { ExpandRpcs } from "@expand/contracts/rpc"
import type { Endpoint } from "@expand/contracts/endpoint"
import { BackendUnavailable, deleteEndpoint, findOrSpawnBackend } from "@expand/client-ts/discovery"
import { supervised } from "@expand/client-ts/supervise"
import type { RuntimeAdapter } from "@expand/client-ts/adapter"

export type ExpandRpcClientApi = RpcClient.FromGroup<typeof ExpandRpcs, RpcClientError.RpcClientError>

/** @internal */
export class ExpandRpcClient extends Context.Service<ExpandRpcClient, ExpandRpcClientApi>()(
  "expand/ExpandRpcClient"
) {}

export const endpointWsUrl = (endpoint: Endpoint): string =>
  `${endpoint.url}?token=${encodeURIComponent(endpoint.token)}`

const CONNECT_TIMEOUT = "3 seconds"
const MAX_ATTEMPTS = 3

class StaleEndpoint extends Data.TaggedError("StaleEndpoint")<{
  readonly reason: string
}> {}

/** @internal */
export const acquireClient = (
  adapter: RuntimeAdapter
): Effect.Effect<
  { readonly client: ExpandRpcClientApi; readonly endpoint: Endpoint },
  BackendUnavailable,
  FileSystem.FileSystem | Scope.Scope
> => {
  const once = findOrSpawnBackend(adapter).pipe(
    Effect.catchIf(
      (e): e is "pending" => e === "pending",
      (e) => Effect.die(e)
    ),
    Effect.flatMap((endpoint) =>
      Effect.gen(function* () {
        const protocol = yield* Layer.build(adapter.protocolLayer(endpointWsUrl(endpoint)))
        const client = yield* RpcClient.make(ExpandRpcs).pipe(Effect.provideContext(protocol))
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
        return { client, endpoint }
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

/** @internal */
export const ExpandRpcClientLive = (
  adapter: RuntimeAdapter
): Layer.Layer<ExpandRpcClient, BackendUnavailable, FileSystem.FileSystem> =>
  Layer.effect(ExpandRpcClient, Effect.map(acquireClient(adapter), ({ client }) => client))
