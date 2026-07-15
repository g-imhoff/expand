import {
  Clock,
  Crypto,
  Effect,
  Encoding,
  FileSystem,
  Option,
  Path,
  PlatformError,
  Schema
} from "effect"
import { ProcessControl } from "@expand/contracts/process-control"
import { SpawnLockError } from "./errors"

export interface SpawnLockLease {
  readonly path: string
  readonly pid: number
  readonly startedAt: number
  readonly token: string
}

export interface SpawnLockOptions {
  readonly afterClaim?: Effect.Effect<void>
  readonly afterObservation?: Effect.Effect<void>
  readonly beforePublish?: (candidatePath: string) => Effect.Effect<void>
}

export const acquireSpawnLock = Effect.fn("SpawnLock.acquire")(function*(
  path: string,
  options: SpawnLockOptions = {}
) {
  yield* secureDirectory(path)
  const lease = yield* publishLease(path, options.beforePublish)
  if (lease !== undefined) return lease

  const observed = yield* readObservedRecord(path)
  if (observed === undefined) return undefined
  const processControl = yield* ProcessControl
  const status = yield* processControl.probe(observed.record.pid).pipe(
    Effect.mapError((cause) => spawnLockError("probe", "probe", path, cause))
  )
  if (status !== "dead") return undefined
  if (options.afterObservation !== undefined) yield* options.afterObservation
  if (!(yield* removeObserved(path, observed, options.afterClaim))) return undefined
  return yield* publishLease(path, options.beforePublish)
})

export const releaseSpawnLock = Effect.fn("SpawnLock.release")(function*(
  lease: SpawnLockLease,
  options: Pick<SpawnLockOptions, "afterClaim"> = {}
) {
  yield* removeObserved(
    lease.path,
    {
      kind: "current",
      record: { pid: lease.pid, startedAt: lease.startedAt, token: lease.token }
    },
    options.afterClaim
  )
})

const PositiveSafeInteger = Schema.Int.check(Schema.isGreaterThan(0))
const NonNegativeSafeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const UuidV4 = Schema.String.check(Schema.isUUID(4))

const CurrentRecordSchema = Schema.Struct({
  pid: PositiveSafeInteger,
  startedAt: NonNegativeSafeInteger,
  token: UuidV4
})
const LegacyRecordSchema = Schema.Struct({
  pid: PositiveSafeInteger,
  startedAt: NonNegativeSafeInteger
})
const CurrentRecordFromJson = Schema.fromJsonString(CurrentRecordSchema)
const LegacyRecordFromJson = Schema.fromJsonString(LegacyRecordSchema)

type CurrentRecord = typeof CurrentRecordSchema.Type
type LegacyRecord = typeof LegacyRecordSchema.Type

type ObservedRecord =
  | { readonly kind: "current"; readonly record: CurrentRecord }
  | { readonly kind: "legacy"; readonly record: LegacyRecord }

const textEncoder = new TextEncoder()
const strictParseOptions = { onExcessProperty: "error" } as const

const secureDirectory = Effect.fn("SpawnLock.secureDirectory")(function*(lockPath: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const parent = path.dirname(lockPath)
  yield* fs.makeDirectory(parent, { recursive: true, mode: 0o700 }).pipe(
    Effect.mapError((cause) => spawnLockError("filesystem", "makeDirectory", parent, cause))
  )
  yield* fs.chmod(parent, 0o700).pipe(
    Effect.mapError((cause) => spawnLockError("filesystem", "chmod", parent, cause))
  )
})

const publishLease = Effect.fn("SpawnLock.publishLease")(function*(
  path: string,
  beforePublish: SpawnLockOptions["beforePublish"]
) {
  const fs = yield* FileSystem.FileSystem
  const cryptoService = yield* Crypto.Crypto
  const processControl = yield* ProcessControl
  const token = yield* cryptoService.randomUUIDv4.pipe(
    Effect.mapError((cause) => spawnLockError("crypto", "randomUUIDv4", path, cause))
  )
  const record: CurrentRecord = {
    pid: processControl.currentPid,
    startedAt: yield* Clock.currentTimeMillis,
    token
  }
  const encoded = yield* Schema.encodeEffect(CurrentRecordFromJson, strictParseOptions)(record).pipe(
    Effect.mapError((cause) => spawnLockError("schema", "encodeCurrentRecord", path, cause))
  )
  const lease: SpawnLockLease = { path, ...record }
  const candidatePath = `${path}.candidate.${record.pid}.${record.token}`

  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.acquireUseRelease(
      Effect.succeed(candidatePath),
      () =>
        Effect.gen(function*() {
          yield* Effect.scoped(
            Effect.gen(function*() {
              const file = yield* fs.open(candidatePath, { flag: "wx", mode: 0o600 }).pipe(
                Effect.mapError((cause) => spawnLockError("filesystem", "open", candidatePath, cause))
              )
              yield* file.writeAll(textEncoder.encode(encoded)).pipe(
                Effect.mapError((cause) => spawnLockError("filesystem", "writeAll", candidatePath, cause))
              )
              yield* file.sync.pipe(
                Effect.mapError((cause) => spawnLockError("filesystem", "sync", candidatePath, cause))
              )
            })
          )
          yield* fs.chmod(candidatePath, 0o600).pipe(
            Effect.mapError((cause) => spawnLockError("filesystem", "chmod", candidatePath, cause))
          )
          if (beforePublish !== undefined) yield* restore(beforePublish(candidatePath))
          const published = yield* fs.link(candidatePath, path).pipe(
            Effect.matchEffect({
              onFailure: (cause) => hasSystemReason(cause, "AlreadyExists")
                ? Effect.succeed(false)
                : Effect.fail(spawnLockError("filesystem", "link", path, cause)),
              onSuccess: () => Effect.succeed(true)
            })
          )
          return published ? lease : undefined
        }),
      (candidate) => removeArtifact(candidate)
    )
  )
})

const readObservedRecord = Effect.fn("SpawnLock.readObservedRecord")(function*(
  path: string
): Effect.fn.Return<ObservedRecord | undefined, SpawnLockError, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(path).pipe(
    Effect.matchEffect({
      onFailure: (cause) => hasSystemReason(cause, "NotFound")
        ? Effect.succeed(undefined)
        : Effect.fail(spawnLockError("filesystem", "readFileString", path, cause)),
      onSuccess: (value) => Effect.succeed(value)
    })
  )
  if (text === undefined) return undefined

  const current = yield* Schema.decodeUnknownEffect(CurrentRecordFromJson, strictParseOptions)(text).pipe(
    Effect.option
  )
  if (Option.isSome(current)) return { kind: "current", record: current.value }

  const legacy = yield* Schema.decodeUnknownEffect(LegacyRecordFromJson, strictParseOptions)(text).pipe(
    Effect.option
  )
  return Option.isSome(legacy) ? { kind: "legacy", record: legacy.value } : undefined
})

const removeObserved = Effect.fn("SpawnLock.removeObserved")(function*(
  path: string,
  observed: ObservedRecord,
  afterClaim: SpawnLockOptions["afterClaim"]
) {
  const fs = yield* FileSystem.FileSystem
  const fingerprint = yield* recordFingerprint(path, observed)
  const claimPath = `${path}.claim.${fingerprint}`
  return yield* Effect.uninterruptibleMask((restore) =>
    fs.link(path, claimPath).pipe(
      Effect.matchEffect({
        onFailure: (cause) => hasSystemReason(cause, "AlreadyExists") || hasSystemReason(cause, "NotFound")
          ? Effect.succeed(false)
          : Effect.fail(spawnLockError("filesystem", "link", claimPath, cause)),
        onSuccess: () =>
          Effect.acquireUseRelease(
            Effect.succeed(claimPath),
            () =>
              Effect.gen(function*() {
                yield* fs.chmod(claimPath, 0o600).pipe(
                  Effect.mapError((cause) => spawnLockError("filesystem", "chmod", claimPath, cause))
                )
                if (afterClaim !== undefined) yield* restore(afterClaim)
                const claimedRecord = yield* readObservedRecord(claimPath)
                const canonicalRecord = yield* readObservedRecord(path)
                if (!sameObserved(claimedRecord, observed) || !sameObserved(canonicalRecord, observed)) return false

                const claimedInfo = yield* statIfPresent(claimPath)
                const canonicalInfo = yield* statIfPresent(path)
                if (claimedInfo === undefined || canonicalInfo === undefined) return false
                if (claimedInfo.dev !== canonicalInfo.dev) return false
                if (Option.isNone(claimedInfo.ino) || Option.isNone(canonicalInfo.ino)) return false
                if (claimedInfo.ino.value !== canonicalInfo.ino.value) return false
                return yield* removeCanonical(path)
              }),
            (claim) => removeArtifact(claim)
          )
      })
    )
  )
})

const legacyFingerprint = Effect.fn("SpawnLock.legacyFingerprint")(function*(
  path: string,
  record: LegacyRecord
) {
  const cryptoService = yield* Crypto.Crypto
  const encoded = yield* Schema.encodeEffect(LegacyRecordFromJson, strictParseOptions)(record).pipe(
    Effect.mapError((cause) => spawnLockError("schema", "encodeLegacyRecord", path, cause))
  )
  const digest = yield* cryptoService.digest("SHA-256", textEncoder.encode(encoded)).pipe(
    Effect.mapError((cause) => spawnLockError("digest", "legacyFingerprint", path, cause))
  )
  return `legacy-${Encoding.encodeHex(digest)}`
})

const recordFingerprint = Effect.fn("SpawnLock.recordFingerprint")(function*(
  path: string,
  observed: ObservedRecord
) {
  return observed.kind === "current"
    ? observed.record.token
    : yield* legacyFingerprint(path, observed.record)
})

const statIfPresent = Effect.fn("SpawnLock.statIfPresent")(function*(path: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.stat(path).pipe(
    Effect.matchEffect({
      onFailure: (cause) => hasSystemReason(cause, "NotFound")
        ? Effect.succeed(undefined)
        : Effect.fail(spawnLockError("filesystem", "stat", path, cause)),
      onSuccess: (info) => Effect.succeed(info)
    })
  )
})

const removeCanonical = Effect.fn("SpawnLock.removeCanonical")(function*(path: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.remove(path).pipe(
    Effect.matchEffect({
      onFailure: (cause) => hasSystemReason(cause, "NotFound")
        ? Effect.succeed(false)
        : Effect.fail(spawnLockError("filesystem", "remove", path, cause)),
      onSuccess: () => Effect.succeed(true)
    })
  )
})

const removeArtifact = Effect.fn("SpawnLock.removeArtifact")(function*(path: string) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.remove(path, { force: true }).pipe(
    Effect.catchIf(
      (cause) => hasSystemReason(cause, "NotFound"),
      () => Effect.void
    ),
    Effect.mapError((cause) => spawnLockError("filesystem", "remove", path, cause))
  )
})

const sameObserved = (left: ObservedRecord | undefined, right: ObservedRecord): boolean => {
  if (left?.kind !== right.kind) return false
  if (left.kind === "current" && right.kind === "current") {
    return left.record.pid === right.record.pid &&
      left.record.startedAt === right.record.startedAt &&
      left.record.token === right.record.token
  }
  if (left.kind === "legacy" && right.kind === "legacy") {
    return left.record.pid === right.record.pid && left.record.startedAt === right.record.startedAt
  }
  return false
}

const hasSystemReason = (
  cause: PlatformError.PlatformError,
  reason: PlatformError.SystemErrorTag
): boolean => cause.reason._tag === reason

const spawnLockError = (
  kind: SpawnLockError["kind"],
  operation: string,
  path: string,
  cause: unknown
) => new SpawnLockError({ kind, operation, path, cause })
