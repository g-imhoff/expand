import { Data, Effect, FileSystem, Option, Schedule, Schema } from "effect"
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs"
import { dirname } from "node:path"
import { type Endpoint, EndpointFromJson, endpointFilePath, PROTOCOL_VERSION } from "@yodea/shared/endpoint"

export class BackendUnavailable extends Data.TaggedError("BackendUnavailable")<{
  readonly reason: string
}> {}

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0) // signal 0 = liveness probe, doesn't actually signal
    return true
  } catch {
    return false
  }
}

// Read + validate the discovery file. None if missing, malformed, wrong
// protocol, or owned by a dead pid (stale).
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

// Spawn `yodea server` as a detached background process. Targets the COMPILED
// binary (process.execPath === dist/yodea), which is the shipped artifact.
const spawnServer = Effect.sync(() => {
  const child = Bun.spawn({
    cmd: [process.execPath, "server"],
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
    env: process.env
  })
  child.unref()
})

const lockPath = () => `${endpointFilePath()}.lock`

// A spawn lock older than this is treated as stale even if its pid is still
// alive — a safety net against pid reuse (a long-dead spawner's pid may have
// been recycled by an unrelated live process). A real spawner advertises
// `server.json` within ~5s (awaitEndpoint's window), so 30s is comfortably
// past any legitimate concurrent spawn.
const LOCK_STALE_AFTER_MS = 30_000

// Lock contents: who holds it (pid) and when (startedAt, epoch millis). The pid
// drives liveness; startedAt is a clock-independent backup that does not rely on
// the filesystem mtime (and lets a future reader reason about age directly).
interface LockInfo {
  readonly pid: number
  readonly startedAt: number
}

// A held lock is STALE if its owner pid is dead OR it is older than
// LOCK_STALE_AFTER_MS (mtime-based; mirrors readEndpoint's pid-liveness check
// but adds an age fence against pid reuse). Unreadable/garbage lock contents
// (dead spawner that crashed mid-write) are treated as stale too. This mirrors
// the staleness handling readEndpoint applies to `server.json`.
const isLockStale = (): boolean => {
  let mtimeMs: number
  try {
    mtimeMs = statSync(lockPath()).mtimeMs
  } catch {
    // The lock vanished between the failed acquire and now — not stale, just gone.
    return false
  }
  if (Date.now() - mtimeMs > LOCK_STALE_AFTER_MS) return true
  try {
    const info = JSON.parse(readFileSync(lockPath(), "utf8")) as Partial<LockInfo>
    if (typeof info.pid !== "number") return true
    return !isProcessAlive(info.pid)
  } catch {
    // Empty/garbage/missing contents => a spawner that died mid-write. Stale.
    return true
  }
}

// One exclusive create attempt (O_EXCL). Stamps our pid + start time into the
// lock so a later acquirer can judge its staleness. Returns true iff WE created
// it; false on EEXIST (someone else holds it) or any other error.
const createLockOnce = (): boolean => {
  try {
    // "wx" => create + fail if exists. Directory is ensured by the server, but
    // for the spawn race we create it here too.
    Bun.spawnSync({ cmd: ["mkdir", "-p", dirname(lockPath())] })
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

// Best-effort exclusive spawn lock. Returns true if WE acquired it.
//
// On EEXIST we inspect the existing lock (mirroring readEndpoint's stale-file
// handling): if it is STALE (dead/garbage/aged-out owner) we delete it and retry
// the create exactly ONCE — recovering from a spawner that was SIGKILLed after
// acquiring the lock but before advertising `server.json` (otherwise the lock
// wedges every future command forever). If the lock is held by a LIVE, recent
// pid we leave it alone and return false: that is a legitimate concurrent
// spawner, and the caller falls through to awaitEndpoint to wait for it.
const tryAcquireLock = Effect.sync(() => {
  if (createLockOnce()) return true
  if (!isLockStale()) return false
  // Stale lock from a crashed spawner — clear it and retry the acquire once.
  // If a fresh spawner won the race between our staleness check and the delete,
  // the retry's EEXIST returns false and we fall through to awaitEndpoint.
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

// Poll the discovery file until a live endpoint appears or we time out.
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

// Remove a stale discovery file (best-effort). Used by the client when a
// discovered endpoint turns out to point at a dead/dying server: deleting it
// forces the next find-or-spawn to spawn a fresh backend instead of re-reading
// the same stale entry and hanging again.
export const deleteEndpoint: Effect.Effect<void, never, FileSystem.FileSystem> =
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.remove(endpointFilePath()).pipe(Effect.ignore)
  })

// I-2/I-4 step 1: find a running backend or spawn exactly one. The server binds
// an ephemeral OS port and advertises the real URL via the discovery file, so
// there is no port to pass in here.
export const findOrSpawnBackend = Effect.gen(function* () {
  const existing = yield* readEndpoint
  if (Option.isSome(existing)) return existing.value

  const acquired = yield* tryAcquireLock
  if (!acquired) {
    // Another CLI is spawning — don't spawn a second server; just wait.
    return yield* awaitEndpoint
  }
  return yield* spawnServer.pipe(
    Effect.andThen(awaitEndpoint),
    Effect.ensuring(releaseLock)
  )
})
