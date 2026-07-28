import { RpcClient } from "effect/unstable/rpc"
import type { RpcClientError } from "effect/unstable/rpc"
import { Cause, Data, Deferred, Effect, Exit, Layer, PlatformError, Stream } from "effect"
import type { Crypto, FileSystem, Path, Scope } from "effect"
import { ExpandRpcs } from "@expand/contracts/rpc"
import type { Endpoint } from "@expand/contracts/endpoint"
import type { AppContext } from "@expand/contracts/app-context"
import type { ProcessControl, ProcessProbeError } from "@expand/contracts/process-control"
import { BackendUnavailable } from "./errors"
import { deleteEndpoint } from "./discovery"
import { findOrSpawnBackend } from "./spawn"
import { supervised } from "./supervise"
import type { RuntimeAdapter } from "./adapter"

export type ExpandRpcClientApi = RpcClient.FromGroup<typeof ExpandRpcs, RpcClientError.RpcClientError>

export const acquireClient = Effect.fn("Client.acquireClient")((
  adapter: RuntimeAdapter
): Effect.Effect<
  { readonly client: ExpandRpcClientApi; readonly endpoint: Endpoint },
  BackendUnavailable,
  FileSystem.FileSystem | Path.Path | Crypto.Crypto | Scope.Scope | AppContext | ProcessControl
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

  const attempt = (retries: number): Effect.Effect<
    Effect.Success<typeof once>,
    Effect.Error<typeof once> | PlatformError.PlatformError,
    Effect.Services<typeof once>
  > => once.pipe(
    Effect.catchTag("StaleEndpoint", (stale) =>
      deleteEndpoint.pipe(
        Effect.exit,
        Effect.flatMap((cleanupExit) => {
          if (Exit.isFailure(cleanupExit)) {
            return Effect.failCause(Cause.combine(
              Cause.fail<StaleEndpoint | PlatformError.PlatformError>(stale),
              cleanupExit.cause
            ))
          }
          return retries > 0
            ? Effect.suspend(() => attempt(retries - 1))
            : Effect.fail(stale)
        })
      )
    )
  )

  return attempt(MAX_ATTEMPTS - 1).pipe(
    Effect.catchCause((cause) => Effect.failCause(Cause.map(cause, mapAcquisitionFailure)))
  )
})

const endpointWsUrl = (endpoint: Endpoint): string =>
  `${endpoint.url}?token=${encodeURIComponent(endpoint.token)}`

const mapAcquisitionFailure = (error: BackendUnavailable | ProcessProbeError | PlatformError.PlatformError | StaleEndpoint) => {
  switch (error._tag) {
  case "BackendUnavailable":
    return error
  case "ProcessProbeError":
    return new BackendUnavailable({
      reason: `process probe failed for pid ${error.pid}: ${String(error.cause)}`,
      cause: error
    })
  case "PlatformError":
    return new BackendUnavailable({
      reason: `stale endpoint cleanup failed: ${String(error)}`,
      cause: error
    })
  case "StaleEndpoint":
    return new BackendUnavailable({ reason: error.reason, cause: error })
  }
}

const CONNECT_TIMEOUT = "3 seconds"
const MAX_ATTEMPTS = 3

class StaleEndpoint extends Data.TaggedError("StaleEndpoint")<{
  readonly reason: string
}> {}
