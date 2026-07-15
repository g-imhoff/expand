import {
  Clock,
  Crypto,
  Data,
  Effect,
  FileSystem,
  Option,
  Path,
  PlatformError,
  Schema,
  Scope
} from "effect"
import { ProcessControl } from "@expand/contracts/process-control"

export interface StateRootLease {
  readonly path: string
  readonly pid: number
  readonly token: string
}

export interface StateRootLockOptions {
  readonly afterClaim?: Effect.Effect<void>
  readonly afterObservation?: Effect.Effect<void>
  readonly beforePublish?: (candidatePath: string) => Effect.Effect<void>
}

export class StateRootLockError extends Data.TaggedError("StateRootLockError")<{
  readonly dataDir: string
  readonly kind?: "endpoint-advertised" | "handoff-timeout" | "live-owner"
  readonly ownerPid?: number
  readonly reason: string
  readonly cause?: unknown
}> {}

export const acquireStateRootLock = Effect.fn("StateRootLock.acquire")(function*(
  dataDir: string,
  options: StateRootLockOptions = {}
) {
  const path = yield* Path.Path
  const normalizedDataDir = path.resolve(dataDir)
  const lockPath = path.join(normalizedDataDir, LOCK_FILE)
  return yield* acquireLease(lockPath, normalizedDataDir, options).pipe(
    Effect.mapError((cause) => asStateRootLockError(normalizedDataDir, cause))
  )
})

export const releaseStateRootLock = Effect.fn("StateRootLock.release")(function*(
  lease: StateRootLease,
  options: Pick<StateRootLockOptions, "afterClaim"> = {}
) {
  const dataDir = dataDirFromLockPath(lease.path)
  yield* removeOwner(
    lease.path,
    dataDir,
    { pid: lease.pid, token: lease.token },
    options.afterClaim
  ).pipe(
    Effect.asVoid,
    Effect.mapError((cause) => asStateRootLockError(dataDir, cause))
  )
})

export const stateRootLock = Effect.fn("StateRootLock.scoped")(function*(
  dataDir: string,
  options: StateRootLockOptions = {}
): Effect.fn.Return<
  StateRootLease,
  StateRootLockError,
  FileSystem.FileSystem | Path.Path | Crypto.Crypto | ProcessControl | Scope.Scope
> {
  return yield* Effect.acquireRelease(
    acquireStateRootLock(dataDir, options),
    (lease) => releaseStateRootLock(lease, options).pipe(Effect.orDie)
  )
})

export const stateRootLockForStartup = Effect.fn("StateRootLock.startup")(function*(
  dataDir: string,
  endpointFile: string,
  options: StateRootLockOptions = {}
): Effect.fn.Return<
  StateRootLease,
  StateRootLockError,
  FileSystem.FileSystem | Path.Path | Crypto.Crypto | ProcessControl | Scope.Scope
> {
  const path = yield* Path.Path
  const normalizedDataDir = path.resolve(dataDir)
  const normalizedEndpointFile = path.resolve(endpointFile)
  const deadline = (yield* Clock.currentTimeMillis) + HANDOFF_TIMEOUT_MS
  return yield* Effect.acquireRelease(
    acquireStartupLease(normalizedDataDir, normalizedEndpointFile, deadline, options).pipe(
      Effect.mapError((cause) => asStateRootLockError(normalizedDataDir, cause))
    ),
    (lease) => releaseStateRootLock(lease, options).pipe(Effect.orDie)
  )
})

const PositiveSafeInteger = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))
const UuidV4 = Schema.String.pipe(Schema.check(Schema.isUUID(4)))
const LockOwnerSchema = Schema.Struct({ pid: PositiveSafeInteger, token: UuidV4 })
const LockOwnerFromJson = Schema.fromJsonString(LockOwnerSchema)

type LockOwner = typeof LockOwnerSchema.Type

const LOCK_FILE = "backend.lock"
const HANDOFF_RETRY_INTERVAL = "50 millis"
const HANDOFF_TIMEOUT_MS = 4_000
const strictParseOptions = { onExcessProperty: "error" } as const
const textEncoder = new TextEncoder()

const acquireLease = Effect.fn("StateRootLock.acquireLease")(function*(
  lockPath: string,
  dataDir: string,
  options: StateRootLockOptions
) {
  yield* secureDirectory(dataDir)
  const first = yield* publishLease(lockPath, options.beforePublish)
  if (first !== undefined) return first

  const staleOwner = yield* readOwner(lockPath, dataDir)
  const processControl = yield* ProcessControl
  const status = yield* processControl.probe(staleOwner.pid)
  if (status !== "dead") return yield* Effect.fail(liveOwnerError(dataDir, staleOwner.pid))
  if (options.afterObservation !== undefined) yield* options.afterObservation
  if (!(yield* removeOwner(lockPath, dataDir, staleOwner, options.afterClaim))) {
    return yield* Effect.fail(ownershipChangedError(dataDir))
  }

  const retry = yield* publishLease(lockPath, options.beforePublish)
  if (retry !== undefined) return retry
  return yield* Effect.fail(ownershipChangedError(dataDir))
})

const acquireStartupLease: (
  dataDir: string,
  endpointFile: string,
  deadline: number,
  options: StateRootLockOptions
) => Effect.Effect<
  StateRootLease,
  StateRootLockError | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | Crypto.Crypto | ProcessControl
> = Effect.fn("StateRootLock.acquireStartup")(function*(
  dataDir: string,
  endpointFile: string,
  deadline: number,
  options: StateRootLockOptions
) {
  return yield* acquireStateRootLock(dataDir, options).pipe(
    Effect.catchIf(
      (error) => error.kind === "live-owner" && error.ownerPid !== undefined,
      (error) => retryLiveOwner(dataDir, endpointFile, deadline, options, error)
    )
  )
})

const retryLiveOwner: (
  dataDir: string,
  endpointFile: string,
  deadline: number,
  options: StateRootLockOptions,
  error: StateRootLockError
) => Effect.Effect<
  StateRootLease,
  StateRootLockError | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | Crypto.Crypto | ProcessControl
> = Effect.fn("StateRootLock.retryLiveOwner")(function*(
  dataDir: string,
  endpointFile: string,
  deadline: number,
  options: StateRootLockOptions,
  error: StateRootLockError
) {
  const ownerPid = error.ownerPid
  if (ownerPid === undefined) return yield* Effect.fail(error)
  if (yield* endpointAdvertised(endpointFile)) {
    return yield* Effect.fail(endpointAdvertisedError(dataDir))
  }
  if ((yield* Clock.currentTimeMillis) >= deadline) {
    return yield* Effect.fail(handoffTimeoutError(dataDir, ownerPid))
  }
  yield* Effect.sleep(HANDOFF_RETRY_INTERVAL)
  return yield* acquireStartupLease(dataDir, endpointFile, deadline, options)
})

const endpointAdvertised = Effect.fn("StateRootLock.endpointAdvertised")(function*(
  endpointFile: string
) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.stat(endpointFile).pipe(
    Effect.matchEffect({
      onFailure: (cause) => hasSystemReason(cause, "NotFound")
        ? Effect.succeed(false)
        : Effect.fail(cause),
      onSuccess: () => Effect.succeed(true)
    })
  )
})

const secureDirectory = Effect.fn("StateRootLock.secureDirectory")(function*(directory: string) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
  yield* fs.chmod(directory, 0o700)
})

const publishLease = Effect.fn("StateRootLock.publish")(function*(
  lockPath: string,
  beforePublish: StateRootLockOptions["beforePublish"]
) {
  const fs = yield* FileSystem.FileSystem
  const cryptoService = yield* Crypto.Crypto
  const processControl = yield* ProcessControl
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function*() {
      const token = yield* cryptoService.randomUUIDv4
      const record: LockOwner = { pid: processControl.currentPid, token }
      const lease: StateRootLease = { path: lockPath, ...record }
      const candidatePath = `${lockPath}.candidate.${record.pid}.${record.token}`
      return yield* Effect.acquireUseRelease(
        Effect.succeed(candidatePath),
        () => Effect.gen(function*() {
          yield* Effect.scoped(
            Effect.gen(function*() {
              const file = yield* fs.open(candidatePath, { flag: "wx", mode: 0o600 })
              const encoded = yield* Schema.encodeEffect(
                LockOwnerFromJson,
                strictParseOptions
              )(record)
              yield* file.writeAll(textEncoder.encode(encoded))
              yield* file.sync
            })
          )
          yield* fs.chmod(candidatePath, 0o600)
          if (beforePublish !== undefined) yield* restore(beforePublish(candidatePath))
          const published = yield* fs.link(candidatePath, lockPath).pipe(
            Effect.matchEffect({
              onFailure: (cause) => hasSystemReason(cause, "AlreadyExists")
                ? Effect.succeed(false)
                : Effect.fail(cause),
              onSuccess: () => Effect.succeed(true)
            })
          )
          return published ? lease : undefined
        }),
        (candidate) => removeArtifact(candidate)
      )
    })
  )
})

const readOwner = Effect.fn("StateRootLock.readOwner")(function*(
  lockPath: string,
  dataDir: string
) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(lockPath).pipe(
    Effect.mapError((cause) => hasSystemReason(cause, "NotFound")
      ? invalidOwnerError(dataDir, cause)
      : cause)
  )
  return yield* Schema.decodeUnknownEffect(LockOwnerFromJson, strictParseOptions)(text).pipe(
    Effect.mapError((cause) => invalidOwnerError(dataDir, cause))
  )
})

const readOwnerIfPresent = Effect.fn("StateRootLock.readOwnerIfPresent")(function*(
  lockPath: string,
  dataDir: string
) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(lockPath).pipe(
    Effect.matchEffect({
      onFailure: (cause) => hasSystemReason(cause, "NotFound")
        ? Effect.succeed(undefined)
        : Effect.fail(cause),
      onSuccess: (value) => Effect.succeed(value)
    })
  )
  if (text === undefined) return undefined
  return yield* Schema.decodeUnknownEffect(LockOwnerFromJson, strictParseOptions)(text).pipe(
    Effect.mapError((cause) => invalidOwnerError(dataDir, cause))
  )
})

const removeOwner = Effect.fn("StateRootLock.removeOwner")(function*(
  lockPath: string,
  dataDir: string,
  expected: LockOwner,
  afterClaim: StateRootLockOptions["afterClaim"]
) {
  const fs = yield* FileSystem.FileSystem
  const claimPath = `${lockPath}.reclaim.${expected.token}`
  return yield* Effect.uninterruptibleMask((restore) =>
    fs.link(lockPath, claimPath).pipe(
      Effect.matchEffect({
        onFailure: (cause) => hasSystemReason(cause, "AlreadyExists") || hasSystemReason(cause, "NotFound")
          ? Effect.succeed(false)
          : Effect.fail(cause),
        onSuccess: () => Effect.acquireUseRelease(
          Effect.succeed(claimPath),
          () => Effect.gen(function*() {
            yield* fs.chmod(claimPath, 0o600)
            if (afterClaim !== undefined) yield* restore(afterClaim)
            const claimedOwner = yield* readOwnerIfPresent(claimPath, dataDir)
            const canonicalOwner = yield* readOwnerIfPresent(lockPath, dataDir)
            if (!sameOwner(claimedOwner, expected) || !sameOwner(canonicalOwner, expected)) return false

            const claim = yield* statIfPresent(claimPath)
            const canonical = yield* statIfPresent(lockPath)
            if (claim === undefined || canonical === undefined) return false
            if (claim.dev !== canonical.dev) return false
            if (Option.isNone(claim.ino) || Option.isNone(canonical.ino)) return false
            if (claim.ino.value !== canonical.ino.value) return false
            return yield* removeCanonical(lockPath)
          }),
          (claim) => removeArtifact(claim)
        )
      })
    )
  )
})

const statIfPresent = Effect.fn("StateRootLock.statIfPresent")(function*(path: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.stat(path).pipe(
    Effect.matchEffect({
      onFailure: (cause) => hasSystemReason(cause, "NotFound")
        ? Effect.succeed(undefined)
        : Effect.fail(cause),
      onSuccess: (info) => Effect.succeed(info)
    })
  )
})

const removeCanonical = Effect.fn("StateRootLock.removeCanonical")(function*(lockPath: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.remove(lockPath).pipe(
    Effect.matchEffect({
      onFailure: (cause) => hasSystemReason(cause, "NotFound")
        ? Effect.succeed(false)
        : Effect.fail(cause),
      onSuccess: () => Effect.succeed(true)
    })
  )
})

const removeArtifact = Effect.fn("StateRootLock.removeArtifact")(function*(path: string) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.remove(path, { force: true }).pipe(
    Effect.catchIf(
      (cause) => hasSystemReason(cause, "NotFound"),
      () => Effect.void
    )
  )
})

const sameOwner = (left: LockOwner | undefined, right: LockOwner): boolean =>
  left?.pid === right.pid && left.token === right.token

const invalidOwnerError = (
  dataDir: string,
  cause: unknown
): StateRootLockError => new StateRootLockError({
  dataDir,
  reason: "state root ownership record is incomplete or invalid",
  cause
})

const ownershipChangedError = (dataDir: string): StateRootLockError =>
  new StateRootLockError({
    dataDir,
    reason: "state root ownership changed while the backend was starting"
  })

const liveOwnerError = (dataDir: string, pid: number): StateRootLockError =>
  new StateRootLockError({
    dataDir,
    kind: "live-owner",
    ownerPid: pid,
    reason: `state root is already owned by backend process ${pid}`
  })

const endpointAdvertisedError = (dataDir: string): StateRootLockError =>
  new StateRootLockError({
    dataDir,
    kind: "endpoint-advertised",
    reason: "state root endpoint is already advertised"
  })

const handoffTimeoutError = (dataDir: string, ownerPid: number): StateRootLockError =>
  new StateRootLockError({
    dataDir,
    kind: "handoff-timeout",
    ownerPid,
    reason: `state root handoff timed out waiting for backend process ${String(ownerPid)}`
  })

const asStateRootLockError = (dataDir: string, cause: unknown): StateRootLockError =>
  cause instanceof StateRootLockError
    ? cause
    : new StateRootLockError({
        dataDir,
        reason: cause instanceof Error && cause.message !== "" ? cause.message : String(cause),
        cause
      })

const dataDirFromLockPath = (lockPath: string): string => {
  const parent = lockPath.slice(0, -LOCK_FILE.length)
  return parent.endsWith("/") || parent.endsWith("\\") ? parent.slice(0, -1) : parent
}

const hasSystemReason = (
  cause: PlatformError.PlatformError,
  reason: PlatformError.SystemErrorTag
): boolean => cause.reason._tag === reason
