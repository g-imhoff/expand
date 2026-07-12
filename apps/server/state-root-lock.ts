import { Data, Effect, Scope } from "effect"
import { randomUUID } from "node:crypto"
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
import { join, resolve } from "node:path"

export interface StateRootLease {
  readonly path: string
  readonly pid: number
  readonly token: string
}

export class StateRootLockError extends Data.TaggedError("StateRootLockError")<{
  readonly dataDir: string
  readonly kind?: "endpoint-advertised" | "handoff-timeout" | "live-owner"
  readonly ownerPid?: number
  readonly reason: string
}> {}

export const acquireStateRootLock = (
  dataDir: string
): Effect.Effect<StateRootLease, StateRootLockError> =>
  Effect.try({
    try: () => acquireLease(dataDir),
    catch: (error) => asStateRootLockError(resolve(dataDir), error)
  })

export const releaseStateRootLock = (lease: StateRootLease): Effect.Effect<void> =>
  Effect.sync(() => {
    const owner = readOwner(lease.path)
    if (owner?.pid !== lease.pid || owner.token !== lease.token) return
    try {
      rmSync(lease.path)
    } catch {}
  })

export const stateRootLock = (
  dataDir: string
): Effect.Effect<StateRootLease, StateRootLockError, Scope.Scope> =>
  Effect.acquireRelease(acquireStateRootLock(dataDir), releaseStateRootLock)

export const stateRootLockForStartup = (
  dataDir: string,
  endpointFile: string
): Effect.Effect<StateRootLease, StateRootLockError, Scope.Scope> => {
  const normalizedDataDir = resolve(dataDir)
  const normalizedEndpointFile = resolve(endpointFile)
  const acquire = Effect.flatMap(
    Effect.sync(() => Date.now() + HANDOFF_TIMEOUT_MS),
    (deadline) => acquireStartupLease(normalizedDataDir, normalizedEndpointFile, deadline)
  )
  return Effect.acquireRelease(acquire, releaseStateRootLock)
}

interface LockOwner {
  readonly pid: number
  readonly token: string
}

const LOCK_FILE = "backend.lock"
const HANDOFF_RETRY_INTERVAL = "50 millis"
const HANDOFF_TIMEOUT_MS = 4_000
const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

const acquireStartupLease = (
  dataDir: string,
  endpointFile: string,
  deadline: number
): Effect.Effect<StateRootLease, StateRootLockError> =>
  acquireStateRootLock(dataDir).pipe(
    Effect.catch((error) => retryLiveOwner(dataDir, endpointFile, deadline, error))
  )

const retryLiveOwner = (
  dataDir: string,
  endpointFile: string,
  deadline: number,
  error: StateRootLockError
): Effect.Effect<StateRootLease, StateRootLockError> => {
  const ownerPid = error.ownerPid
  if (error.kind !== "live-owner" || ownerPid === undefined) return Effect.fail(error)
  return endpointIsAdvertised(dataDir, endpointFile).pipe(
    Effect.flatMap((advertised) => {
      if (advertised) return Effect.fail(endpointAdvertisedError(dataDir))
      if (Date.now() >= deadline) {
        return Effect.fail(new StateRootLockError({
          dataDir,
          kind: "handoff-timeout",
          ownerPid,
          reason: `state root handoff timed out waiting for backend process ${String(ownerPid)}`
        }))
      }
      return Effect.sleep(HANDOFF_RETRY_INTERVAL).pipe(
        Effect.andThen(acquireStartupLease(dataDir, endpointFile, deadline))
      )
    })
  )
}

const endpointIsAdvertised = (
  dataDir: string,
  endpointFile: string
): Effect.Effect<boolean, StateRootLockError> =>
  Effect.try({
    try: () => {
      try {
        statSync(endpointFile)
        return true
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return false
        throw error
      }
    },
    catch: (error) => asStateRootLockError(dataDir, error)
  })

const acquireLease = (input: string): StateRootLease => {
  const dataDir = resolve(input)
  const path = join(dataDir, LOCK_FILE)
  secureStateRoot(dataDir)

  const first = createLease(path)
  if (first !== undefined) return first

  const staleOwner = readOwner(path)
  if (staleOwner === undefined) {
    throw new StateRootLockError({
      dataDir,
      reason: "state root ownership record is incomplete or invalid"
    })
  }
  if (isProcessAlive(staleOwner.pid)) throw liveOwnerError(dataDir, staleOwner.pid)

  reclaimStaleOwner(path, staleOwner)

  const retry = createLease(path)
  if (retry !== undefined) return retry

  const replacement = readOwner(path)
  if (replacement !== undefined && isProcessAlive(replacement.pid)) {
    throw liveOwnerError(dataDir, replacement.pid)
  }

  throw new StateRootLockError({
    dataDir,
    reason: "state root ownership changed while the backend was starting"
  })
}

const createLease = (path: string): StateRootLease | undefined => {
  const lease = { path, pid: process.pid, token: randomUUID() }
  const candidatePath = `${path}.candidate.${lease.pid}.${lease.token}`
  const record = JSON.stringify({ pid: lease.pid, token: lease.token })

  try {
    const descriptor = openSync(candidatePath, "wx", 0o600)
    try {
      writeFileSync(descriptor, record)
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    chmodSync(candidatePath, 0o600)

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

const readOwner = (path: string): LockOwner | undefined => {
  try {
    const candidate = JSON.parse(readFileSync(path, "utf8")) as Partial<LockOwner>
    if (!Number.isSafeInteger(candidate.pid) || (candidate.pid ?? 0) <= 0) return undefined
    if (typeof candidate.token !== "string" || !TOKEN_PATTERN.test(candidate.token)) return undefined
    return { pid: candidate.pid as number, token: candidate.token }
  } catch {
    return undefined
  }
}

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM"
  }
}

const asStateRootLockError = (dataDir: string, error: unknown): StateRootLockError =>
  error instanceof StateRootLockError
    ? error
    : new StateRootLockError({
        dataDir,
        reason: error instanceof Error ? error.message : String(error)
      })

const secureStateRoot = (dataDir: string): void => {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  chmodSync(dataDir, 0o700)
}

const reclaimStaleOwner = (path: string, staleOwner: LockOwner): void => {
  const claimPath = `${path}.reclaim.${staleOwner.token}`

  try {
    linkSync(path, claimPath)
  } catch (error) {
    if (isNodeError(error) && (error.code === "EEXIST" || error.code === "ENOENT")) return
    throw error
  }

  try {
    const claimedOwner = readOwner(claimPath)
    const canonicalOwner = readOwner(path)
    if (!sameOwner(claimedOwner, staleOwner) || !sameOwner(canonicalOwner, staleOwner)) return

    const claim = statSync(claimPath)
    const canonical = statSync(path)
    if (claim.dev !== canonical.dev || claim.ino !== canonical.ino) return

    rmSync(path)
  } finally {
    rmSync(claimPath, { force: true })
  }
}

const sameOwner = (left: LockOwner | undefined, right: LockOwner): boolean =>
  left?.pid === right.pid && left.token === right.token

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

const isNodeError = (error: unknown): error is NodeJS.ErrnoException => error instanceof Error
