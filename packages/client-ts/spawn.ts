import { Effect, Option, Schedule } from "effect"
import { AppContext } from "@expand/contracts/app-context"
import type { RuntimeAdapter } from "./adapter"
import { BackendUnavailable, type SpawnLockError } from "./errors"
import { readEndpoint } from "./discovery"
import { acquireSpawnLock, releaseSpawnLock } from "./spawn-lock"

export const findOrSpawnBackend = Effect.fn("Spawn.findOrSpawnBackend")(function*(adapter: RuntimeAdapter) {
  const { paths } = yield* AppContext
  return yield* Effect.gen(function*() {
    const existing = yield* readEndpoint
    if (Option.isSome(existing)) return existing.value
    const lease = yield* acquireSpawnLock(paths.spawnLockFile)
    if (lease === undefined) return yield* Effect.fail("pending" as const)
    return yield* Effect.acquireUseRelease(
      Effect.succeed(lease),
      () => adapter.spawnBackend(paths.dataDir).pipe(Effect.andThen(awaitEndpoint)),
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

const awaitEndpoint = readEndpoint.pipe(
  Effect.flatMap((o) => (Option.isSome(o) ? Effect.succeed(o.value) : Effect.fail("pending" as const))),
  Effect.retry({
    schedule: Schedule.spaced("100 millis"),
    while: (error) => error === "pending"
  })
)
