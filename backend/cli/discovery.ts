import { Data, Effect, FileSystem, Option, Schedule, Schema } from "effect"
import { closeSync, openSync, rmSync } from "node:fs"
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

export interface SpawnOptions {
  readonly port: number
}

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

// Best-effort exclusive spawn lock (O_EXCL). Returns true if WE acquired it.
const tryAcquireLock = Effect.sync(() => {
  try {
    // "wx" => create + fail if exists. Directory is ensured by the server, but
    // for the spawn race we create it here too.
    Bun.spawnSync({ cmd: ["mkdir", "-p", dirname(lockPath())] })
    const fd = openSync(lockPath(), "wx")
    closeSync(fd)
    return true
  } catch {
    return false
  }
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

// I-2/I-4 step 1: find a running backend or spawn exactly one.
export const findOrSpawnBackend = (options: SpawnOptions) =>
  Effect.gen(function* () {
    void options.port
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
