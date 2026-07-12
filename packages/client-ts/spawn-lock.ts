import { Effect } from "effect"
import { createHash, randomUUID } from "node:crypto"
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs"
import { dirname } from "node:path"

export interface SpawnLockLease {
  readonly path: string
  readonly pid: number
  readonly startedAt: number
  readonly token: string
}

export interface SpawnLockOptions {
  readonly afterClaim?: () => void
  readonly afterObservation?: () => void
  readonly beforePublish?: (candidatePath: string) => void
  readonly probeProcess?: (pid: number) => void
}

export const acquireSpawnLock = (
  path: string,
  options: SpawnLockOptions = {}
): Effect.Effect<SpawnLockLease | undefined> =>
  Effect.sync(() => {
    try {
      secureDirectory(path)
      const lease = publishLease(path, options.beforePublish)
      if (lease !== undefined) return lease

      const observed = readObservedRecord(path)
      if (observed === undefined || isProcessAlive(observed.record.pid, options.probeProcess)) return undefined
      options.afterObservation?.()
      if (!removeObserved(path, observed, options.afterClaim)) return undefined
      return publishLease(path, options.beforePublish)
    } catch {
      return undefined
    }
  })

export const releaseSpawnLock = (
  lease: SpawnLockLease,
  options: Pick<SpawnLockOptions, "afterClaim"> = {}
): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      removeObserved(
        lease.path,
        {
          kind: "current",
          record: { pid: lease.pid, startedAt: lease.startedAt, token: lease.token }
        },
        options.afterClaim
      )
    } catch {}
  })

interface CurrentRecord {
  readonly pid: number
  readonly startedAt: number
  readonly token: string
}

interface LegacyRecord {
  readonly pid: number
  readonly startedAt: number
}

type ObservedRecord =
  | { readonly kind: "current"; readonly record: CurrentRecord }
  | { readonly kind: "legacy"; readonly record: LegacyRecord }

const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

const publishLease = (
  path: string,
  beforePublish: ((candidatePath: string) => void) | undefined
): SpawnLockLease | undefined => {
  const lease = { path, pid: process.pid, startedAt: Date.now(), token: randomUUID() }
  const candidatePath = `${path}.candidate.${lease.pid}.${lease.token}`
  try {
    const descriptor = openSync(candidatePath, "wx", 0o600)
    try {
      writeFileSync(descriptor, JSON.stringify({
        pid: lease.pid,
        startedAt: lease.startedAt,
        token: lease.token
      }))
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    chmodSync(candidatePath, 0o600)
    beforePublish?.(candidatePath)
    try {
      linkSync(candidatePath, path)
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") return undefined
      throw error
    }
    return lease
  } finally {
    rmSync(candidatePath, { force: true })
  }
}

const removeObserved = (
  path: string,
  observed: ObservedRecord,
  afterClaim: (() => void) | undefined
): boolean => {
  const claimPath = `${path}.claim.${recordFingerprint(observed)}`
  try {
    linkSync(path, claimPath)
  } catch (error) {
    if (isNodeError(error) && (error.code === "EEXIST" || error.code === "ENOENT")) return false
    throw error
  }

  try {
    chmodSync(claimPath, 0o600)
    afterClaim?.()
    const claimed = readObservedRecord(claimPath)
    const canonical = readObservedRecord(path)
    if (!sameObserved(claimed, observed) || !sameObserved(canonical, observed)) return false
    const claimStat = statSync(claimPath)
    const canonicalStat = statSync(path)
    if (claimStat.dev !== canonicalStat.dev || claimStat.ino !== canonicalStat.ino) return false
    try {
      rmSync(path)
      return true
    } catch {
      return false
    }
  } finally {
    rmSync(claimPath, { force: true })
  }
}

const readObservedRecord = (path: string): ObservedRecord | undefined => {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
    const candidate = value as Record<string, unknown>
    const keys = Object.keys(candidate).sort().join(",")
    if (!validPid(candidate.pid) || !validStartedAt(candidate.startedAt)) return undefined
    if (keys === "pid,startedAt,token" && typeof candidate.token === "string" && TOKEN_PATTERN.test(candidate.token)) {
      return {
        kind: "current",
        record: { pid: candidate.pid, startedAt: candidate.startedAt, token: candidate.token }
      }
    }
    if (keys === "pid,startedAt") {
      return { kind: "legacy", record: { pid: candidate.pid, startedAt: candidate.startedAt } }
    }
    return undefined
  } catch {
    return undefined
  }
}

const validPid = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0

const validStartedAt = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0

const isProcessAlive = (pid: number, probeProcess: ((pid: number) => void) | undefined): boolean => {
  try {
    ;(probeProcess ?? ((candidate) => process.kill(candidate, 0)))(pid)
    return true
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM"
  }
}

const sameObserved = (left: ObservedRecord | undefined, right: ObservedRecord): boolean => {
  if (left?.kind !== right.kind) return false
  if (left.record.pid !== right.record.pid || left.record.startedAt !== right.record.startedAt) return false
  return left.kind === "legacy" || left.record.token === (right as Extract<ObservedRecord, { kind: "current" }>).record.token
}

const recordFingerprint = (observed: ObservedRecord): string =>
  observed.kind === "current"
    ? observed.record.token
    : `legacy-${createHash("sha256").update(JSON.stringify(observed.record)).digest("hex")}`

const secureDirectory = (path: string): void => {
  const parent = dirname(path)
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  chmodSync(parent, 0o700)
}

const isNodeError = (error: unknown): error is NodeJS.ErrnoException => error instanceof Error
