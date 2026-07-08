import { Data, Effect, FileSystem, Option, Schedule, Schema } from "effect"
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs"
import { dirname } from "node:path"
import { type Endpoint, EndpointFromJson, PROTOCOL_VERSION } from "@expand/contracts/endpoint"
import { AppContext } from "@expand/contracts/app-context"
import type { RuntimeAdapter } from "@expand/client-ts/adapter"

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
    const { paths } = yield* AppContext
    if (!(yield* fs.exists(paths.endpointFile).pipe(Effect.orElseSucceed(() => false)))) {
      return Option.none()
    }
    const text = yield* fs.readFileString(paths.endpointFile).pipe(Effect.orElseSucceed(() => ""))
    const decoded = yield* Schema.decodeUnknownEffect(EndpointFromJson)(text).pipe(Effect.option)
    if (Option.isNone(decoded)) return Option.none()
    const endpoint = decoded.value
    if (endpoint.protocolVersion !== PROTOCOL_VERSION) return Option.none()
    if (!isProcessAlive(endpoint.pid)) return Option.none()
    return Option.some(endpoint)
  })

const LOCK_STALE_AFTER_MS = 30_000

const isLockStale = (lockPath: string): boolean => {
  let mtimeMs: number
  try {
    mtimeMs = statSync(lockPath).mtimeMs
  } catch {
    return false
  }
  if (Date.now() - mtimeMs > LOCK_STALE_AFTER_MS) return true
  try {
    const info = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockInfo>
    if (typeof info.pid !== "number") return true
    return !isProcessAlive(info.pid)
  } catch {
    return true
  }
}

const createLockOnce = (lockPath: string): boolean => {
  try {
    mkdirSync(dirname(lockPath), { recursive: true })
    const fd = openSync(lockPath, "wx")
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

const tryAcquireLock = (lockPath: string) =>
  Effect.sync(() => {
    if (createLockOnce(lockPath)) return true
    if (!isLockStale(lockPath)) return false
    try {
      rmSync(lockPath, { force: true })
    } catch {}
    return createLockOnce(lockPath)
  })

const releaseLock = (lockPath: string) =>
  Effect.sync(() => {
    try {
      rmSync(lockPath, { force: true })
    } catch {}
  })

const awaitEndpoint = readEndpoint.pipe(
  Effect.flatMap((o) => (Option.isSome(o) ? Effect.succeed(o.value) : Effect.fail("pending" as const))),
  Effect.retry(Schedule.spaced("50 millis")),
  Effect.timeoutOrElse({
    duration: "5 seconds",
    orElse: () => Effect.fail(new BackendUnavailable({ reason: "backend did not start in time" }))
  })
)

/** @internal */
export const deleteEndpoint: Effect.Effect<void, never, FileSystem.FileSystem> =
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const { paths } = yield* AppContext
    yield* fs.remove(paths.endpointFile).pipe(Effect.ignore)
  })

/** @internal */
export const findOrSpawnBackend = (adapter: RuntimeAdapter) =>
  Effect.gen(function* () {
    const { paths } = yield* AppContext
    const lockPath = `${paths.endpointFile}.lock`
    const existing = yield* readEndpoint
    if (Option.isSome(existing)) return existing.value
    const acquired = yield* tryAcquireLock(lockPath)
    if (!acquired) return yield* awaitEndpoint
    return yield* adapter.spawnBackend(paths.dataDir).pipe(
      Effect.andThen(awaitEndpoint),
      Effect.ensuring(releaseLock(lockPath))
    )
  })

interface LockInfo {
  readonly pid: number
  readonly startedAt: number
}
