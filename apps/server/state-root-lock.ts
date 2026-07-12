import { Data, Effect, Scope } from "effect"
import { randomUUID } from "node:crypto"
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs"
import { join, resolve } from "node:path"

export interface StateRootLease {
  readonly path: string
  readonly pid: number
  readonly token: string
}

export class StateRootLockError extends Data.TaggedError("StateRootLockError")<{
  readonly dataDir: string
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

interface LockOwner {
  readonly pid: number
  readonly token: string
}

const LOCK_FILE = "backend.lock"
const ACQUIRE_ATTEMPTS = 3

const acquireLease = (input: string): StateRootLease => {
  const dataDir = resolve(input)
  const path = join(dataDir, LOCK_FILE)
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })

  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt++) {
    const lease = createLease(path)
    if (lease !== undefined) return lease

    const owner = readOwner(path)
    if (owner !== undefined && isProcessAlive(owner.pid)) {
      throw new StateRootLockError({
        dataDir,
        reason: `state root is already owned by backend process ${owner.pid}`
      })
    }

    try {
      rmSync(path)
    } catch {}
  }

  throw new StateRootLockError({
    dataDir,
    reason: "state root ownership changed while the backend was starting"
  })
}

const createLease = (path: string): StateRootLease | undefined => {
  const lease = { path, pid: process.pid, token: randomUUID() }
  let descriptor: number

  try {
    descriptor = openSync(path, "wx", 0o600)
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") return undefined
    throw error
  }

  try {
    writeSync(descriptor, JSON.stringify({ pid: lease.pid, token: lease.token }))
    closeSync(descriptor)
  } catch (error) {
    try {
      closeSync(descriptor)
    } catch {}
    try {
      rmSync(path)
    } catch {}
    throw error
  }

  return lease
}

const readOwner = (path: string): LockOwner | undefined => {
  try {
    const candidate = JSON.parse(readFileSync(path, "utf8")) as Partial<LockOwner>
    if (!Number.isSafeInteger(candidate.pid) || (candidate.pid ?? 0) <= 0) return undefined
    if (typeof candidate.token !== "string" || candidate.token.length === 0) return undefined
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

const isNodeError = (error: unknown): error is NodeJS.ErrnoException => error instanceof Error
