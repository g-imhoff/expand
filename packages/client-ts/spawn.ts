import { Effect, Option, Schedule } from "effect"
import { AppContext } from "@expand/contracts/app-context"
import type { Endpoint } from "@expand/contracts/endpoint"
import type { RuntimeAdapter } from "./adapter"
import { BackendUnavailable, type SpawnLockError } from "./errors"
import { readEndpoint } from "./discovery"
import { acquireSpawnLock, releaseSpawnLock } from "./spawn-lock"

export const findOrSpawnBackend = Effect.fn("Spawn.findOrSpawnBackend")(function*(
  adapter: RuntimeAdapter,
  rejectedEndpoints: ReadonlyArray<Endpoint> = []
) {
  const { paths } = yield* AppContext
  return yield* Effect.gen(function*() {
    const existing = yield* readEndpoint
    if (Option.isSome(existing) && !isRejected(existing.value, rejectedEndpoints)) {
      return existing.value
    }
    const lease = yield* acquireSpawnLock(paths.spawnLockFile)
    if (lease === undefined) return yield* Effect.fail("pending" as const)
    return yield* Effect.acquireUseRelease(
      Effect.succeed(lease),
      () => adapter.spawnBackend(paths.dataDir).pipe(
        Effect.andThen(awaitEndpoint(rejectedEndpoints))
      ),
      (heldLease) => releaseSpawnLock(heldLease)
    )
  }).pipe(
    Effect.retry({
      schedule: Schedule.spaced("100 millis"),
      while: (error) => error === "pending"
    }),
    Effect.timeoutOrElse({
      duration: BACKEND_START_DEADLINE,
      orElse: () => Effect.fail(new BackendUnavailable({ reason: "backend did not start in time" }))
    }),
    Effect.catchTag("SpawnLockError", (error) =>
      Effect.fail(spawnLockUnavailable(error))
    )
  )
})

const spawnLockUnavailable = (error: SpawnLockError): BackendUnavailable =>
  new BackendUnavailable({
    reason: `spawn lock ${error.operation} failed at ${error.path}: ${String(error.cause)}`
  })
const BACKEND_START_DEADLINE = "30 seconds"

const awaitEndpoint = (rejectedEndpoints: ReadonlyArray<Endpoint>) => readEndpoint.pipe(
  Effect.flatMap((endpoint) =>
    Option.isSome(endpoint) && !isRejected(endpoint.value, rejectedEndpoints)
      ? Effect.succeed(endpoint.value)
      : Effect.fail("pending" as const)
  ),
  Effect.retry({
    schedule: Schedule.spaced("100 millis"),
    while: (error) => error === "pending"
  })
)

const isRejected = (
  endpoint: Endpoint,
  rejectedEndpoints: ReadonlyArray<Endpoint>
): boolean => rejectedEndpoints.some((rejected) =>
  rejected.url === endpoint.url &&
  rejected.token === endpoint.token &&
  rejected.pid === endpoint.pid &&
  rejected.protocolVersion === endpoint.protocolVersion
)
