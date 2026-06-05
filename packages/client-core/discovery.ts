import { Data, Effect, FileSystem, Option, Schedule, Schema } from "effect"
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs"
import { dirname } from "node:path"
import { type Endpoint, EndpointFromJson, endpointFilePath, PROTOCOL_VERSION } from "@yodea/contracts/endpoint"
import type { RuntimeAdapter } from "@yodea/client-core/adapter"

export class BackendUnavailable extends Data.TaggedError("BackendUnavailable")<{
  readonly reason: string
}> {}

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export const readEndpoint: Effect.Effect<Option.Option<Endpoint>, never, FileSystem.FileSystem> =
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const file = endpointFilePath()
    if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) {
      return Option.none()
    }
    const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
    const decoded = yield* Schema.decodeUnknownEffect(EndpointFromJson)(text).pipe(Effect.option)
    if (Option.isNone(decoded)) return Option.none()
    const endpoint = decoded.value
    if (endpoint.protocolVersion !== PROTOCOL_VERSION) return Option.none()
    if (!isProcessAlive(endpoint.pid)) return Option.none()
    return Option.some(endpoint)
  })

const lockPath = () => `${endpointFilePath()}.lock`

const LOCK_STALE_AFTER_MS = 30_000

interface LockInfo {
  readonly pid: number
  readonly startedAt: number
}

const isLockStale = (): boolean => {
  let mtimeMs: number
  try {
    mtimeMs = statSync(lockPath()).mtimeMs
  } catch {
    return false
  }
  if (Date.now() - mtimeMs > LOCK_STALE_AFTER_MS) return true
  try {
    const info = JSON.parse(readFileSync(lockPath(), "utf8")) as Partial<LockInfo>
    if (typeof info.pid !== "number") return true
    return !isProcessAlive(info.pid)
  } catch {
    return true
  }
}

const createLockOnce = (): boolean => {
  try {
    mkdirSync(dirname(lockPath()), { recursive: true })
    const fd = openSync(lockPath(), "wx")
    try {
      const info: LockInfo = { pid: process.pid, startedAt: Date.now() }
      writeSync(fd, JSON.stringify(info))
    } finally {
      closeSync(fd)
    }
    return true
  } catch {
    return false
  }
}

const tryAcquireLock = Effect.sync(() => {
  if (createLockOnce()) return true
  if (!isLockStale()) return false
  try {
    rmSync(lockPath(), { force: true })
  } catch {}
  return createLockOnce()
})
const releaseLock = Effect.sync(() => {
  try {
    rmSync(lockPath(), { force: true })
  } catch {}
})

const awaitEndpoint = readEndpoint.pipe(
  Effect.flatMap((o) =>
    Option.isSome(o) ? Effect.succeed(o.value) : Effect.fail("pending" as const)
  ),
  Effect.retry(Schedule.spaced("50 millis")),
  Effect.timeoutOrElse({
    duration: "5 seconds",
    orElse: () => Effect.fail(new BackendUnavailable({ reason: "backend did not start in time" }))
  })
)

export const deleteEndpoint: Effect.Effect<void, never, FileSystem.FileSystem> =
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.remove(endpointFilePath()).pipe(Effect.ignore)
  })

export const findOrSpawnBackend = (adapter: RuntimeAdapter) =>
  Effect.gen(function* () {
    const existing = yield* readEndpoint
    if (Option.isSome(existing)) return existing.value
    const acquired = yield* tryAcquireLock
    if (!acquired) return yield* awaitEndpoint
    return yield* adapter.spawnBackend.pipe(
      Effect.andThen(awaitEndpoint),
      Effect.ensuring(releaseLock)
    )
  })
