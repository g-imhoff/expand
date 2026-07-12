import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect } from "effect"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  acquireStateRootLock,
  releaseStateRootLock,
  StateRootLockError
} from "@expand/server/state-root-lock"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "expand-state-root-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("state root ownership (I-2)", () => {
  it("rejects a second live owner for the same state root", async () => {
    const first = await Effect.runPromise(acquireStateRootLock(dir))
    const error = await Effect.runPromise(Effect.flip(acquireStateRootLock(dir)))

    expect(error).toBeInstanceOf(StateRootLockError)
    expect(error).toMatchObject({ dataDir: dir })

    await Effect.runPromise(releaseStateRootLock(first))
  })

  it("allows live owners for different state roots", async () => {
    const otherDir = join(dir, "other")
    const first = await Effect.runPromise(acquireStateRootLock(dir))
    const second = await Effect.runPromise(acquireStateRootLock(otherDir))

    expect(first.path).toBe(join(dir, "backend.lock"))
    expect(second.path).toBe(join(otherDir, "backend.lock"))
    expect(statSync(second.path).mode & 0o777).toBe(0o600)
    expect(statSync(otherDir).mode & 0o777).toBe(0o700)

    await Effect.runPromise(releaseStateRootLock(first))
    await Effect.runPromise(releaseStateRootLock(second))
  })

  it("recovers a lock whose owner is no longer alive", async () => {
    const lockPath = join(dir, "backend.lock")
    writeFileSync(lockPath, JSON.stringify({ pid: 2_147_483_647, token: "stale" }))

    const lease = await Effect.runPromise(acquireStateRootLock(dir))

    expect(lease.pid).toBe(process.pid)
    expect(lease.token).not.toBe("stale")

    await Effect.runPromise(releaseStateRootLock(lease))
  })

  it("does not remove a replacement owner's lock", async () => {
    const lease = await Effect.runPromise(acquireStateRootLock(dir))
    const replacement = { pid: process.pid, token: "replacement" }
    writeFileSync(lease.path, JSON.stringify(replacement))

    await Effect.runPromise(releaseStateRootLock(lease))

    expect(JSON.parse(readFileSync(lease.path, "utf8"))).toEqual(replacement)
  })
})
