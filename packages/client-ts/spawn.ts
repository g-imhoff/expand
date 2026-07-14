import { Effect, Option, Schedule } from "effect"
import { AppContext } from "@expand/contracts/app-context"
import type { RuntimeAdapter } from "./adapter"
import { BackendUnavailable } from "./errors"
import { readEndpoint } from "./discovery"
import { acquireSpawnLock, releaseSpawnLock } from "./spawn-lock"

export const findOrSpawnBackend = (adapter: RuntimeAdapter) =>
  Effect.gen(function*() {
    const { paths } = yield* AppContext
    const existing = yield* readEndpoint
    if (Option.isSome(existing)) return existing.value
    const lease = yield* acquireSpawnLock(paths.spawnLockFile)
    if (lease === undefined) return yield* awaitEndpoint
    return yield* adapter.spawnBackend(paths.dataDir).pipe(
      Effect.andThen(awaitEndpoint),
      Effect.ensuring(releaseSpawnLock(lease))
    )
  })
const BACKEND_START_DEADLINE = "30 seconds"

const awaitEndpoint = readEndpoint.pipe(
  Effect.flatMap((o) => (Option.isSome(o) ? Effect.succeed(o.value) : Effect.fail("pending" as const))),
  Effect.retry({
    schedule: Schedule.spaced("100 millis"),
    while: (error) => error === "pending"
  }),
  Effect.timeoutOrElse({
    duration: BACKEND_START_DEADLINE,
    orElse: () => Effect.fail(new BackendUnavailable({ reason: "backend did not start in time" }))
  })
)
