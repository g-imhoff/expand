import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { BunFileSystem } from "@effect/platform-bun"
import { Deferred, Effect, Fiber, Option } from "effect"
import { randomUUID } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AppPath } from "@expand/contracts/app-context"
import {
  acquireCoordinationLock,
  acquireOwnershipLock,
  releaseStateRootLock
} from "@expand/server/state-root-lock"
import { startupOwnership } from "@expand/server/startup-ownership"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "expand-startup-ownership-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("startup ownership", () => {
  it("serializes paused cross-channel first starts through root-lease acquisition", async () => {
    const legacyDir = join(dir, ".expand")
    const devDir = join(legacyDir, "expand-dev")
    const releaseDir = join(legacyDir, "expand")
    const guardPath = join(dir, ".expand-locks", "legacy-migration.lock")
    mkdirSync(legacyDir)
    writeFileSync(join(legacyDir, "events.db"), "legacy-db")
    writeFileSync(join(legacyDir, "marker"), "legacy")

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const firstEntered = yield* Deferred.make<void>()
          const releaseFirst = yield* Deferred.make<void>()
          const secondEntered = yield* Deferred.make<void>()
          const first = yield* Effect.forkChild(
            startupOwnership(appPaths(devDir), {
              defaultDir: devDir,
              legacyDir,
              migrationLockFile: guardPath,
              beforeMigration: Deferred.succeed(firstEntered, undefined).pipe(
                Effect.andThen(Deferred.await(releaseFirst))
              )
            })
          )
          yield* Deferred.await(firstEntered)
          const second = yield* Effect.forkChild(
            startupOwnership(appPaths(releaseDir), {
              defaultDir: releaseDir,
              legacyDir,
              migrationLockFile: guardPath,
              beforeMigration: Deferred.succeed(secondEntered, undefined)
            })
          )
          yield* Effect.sleep("100 millis")

          expect(Option.isNone(yield* Deferred.poll(secondEntered))).toBe(true)
          expect(second.pollUnsafe()).toBeUndefined()
          expect(existsSync(devDir)).toBe(false)
          expect(existsSync(releaseDir)).toBe(false)
          expect(existsSync(join(devDir, "backend.lock"))).toBe(false)
          expect(existsSync(join(releaseDir, "backend.lock"))).toBe(false)
          expect(existsSync(guardPath)).toBe(true)

          yield* Deferred.succeed(releaseFirst, undefined)
          const firstLease = yield* Fiber.join(first)
          const secondLease = yield* Fiber.join(second)

          expect(firstLease.path).toBe(join(devDir, "backend.lock"))
          expect(secondLease.path).toBe(join(releaseDir, "backend.lock"))
          expect(existsSync(join(devDir, "marker"))).toBe(true)
          expect(existsSync(join(legacyDir, "events.db"))).toBe(false)
          expect(existsSync(guardPath)).toBe(false)
        })
      ).pipe(Effect.provide(BunFileSystem.layer))
    )

    expect(existsSync(join(devDir, "backend.lock"))).toBe(false)
    expect(existsSync(join(releaseDir, "backend.lock"))).toBe(false)
  })

  it("bypasses migration coordination for a non-default root", async () => {
    const legacyDir = join(dir, ".expand")
    const defaultDir = join(legacyDir, "expand-dev")
    const overrideDir = join(dir, "override")
    const guardPath = join(dir, ".expand-locks", "legacy-migration.lock")
    mkdirSync(legacyDir)
    writeFileSync(join(legacyDir, "events.db"), "legacy-db")

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const lease = yield* startupOwnership(appPaths(overrideDir), {
            defaultDir,
            legacyDir,
            migrationLockFile: guardPath,
            beforeMigration: Effect.die("non-default migration hook ran")
          })
          expect(lease.path).toBe(join(overrideDir, "backend.lock"))
          expect(existsSync(lease.path)).toBe(true)
          expect(existsSync(guardPath)).toBe(false)
          expect(existsSync(join(legacyDir, "events.db"))).toBe(true)
          expect(existsSync(defaultDir)).toBe(false)
        })
      ).pipe(Effect.provide(BunFileSystem.layer))
    )

    expect(existsSync(join(overrideDir, "backend.lock"))).toBe(false)
  })

  it("waits for a live migration guard and secures coordination modes", async () => {
    const guardPath = join(dir, ".expand-locks", "legacy-migration.lock")
    const first = await Effect.runPromise(acquireOwnershipLock(guardPath))

    const second = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(acquireCoordinationLock(guardPath))
          yield* Effect.sleep("100 millis")
          expect(fiber.pollUnsafe()).toBeUndefined()
          yield* releaseStateRootLock(first)
          return yield* Fiber.join(fiber)
        })
      )
    )

    expect(statSync(join(dir, ".expand-locks")).mode & 0o777).toBe(0o700)
    expect(statSync(guardPath).mode & 0o777).toBe(0o600)
    await Effect.runPromise(releaseStateRootLock(second))
  })

  it("bounds a live migration guard that never releases", async () => {
    const guardPath = join(dir, ".expand-locks", "legacy-migration.lock")
    const first = await Effect.runPromise(acquireOwnershipLock(guardPath))
    const startedAt = performance.now()

    const error = await Effect.runPromise(
      Effect.flip(acquireCoordinationLock(guardPath)).pipe(Effect.timeout("5 seconds"))
    )

    const elapsed = performance.now() - startedAt
    expect(error).toMatchObject({ kind: "handoff-timeout", ownerPid: process.pid })
    expect(elapsed).toBeGreaterThanOrEqual(3_900)
    expect(elapsed).toBeLessThan(5_000)
    await Effect.runPromise(releaseStateRootLock(first))
  }, 7_000)

  it("recovers a stale migration guard through the server ownership machinery", async () => {
    const coordinationDir = join(dir, ".expand-locks")
    const guardPath = join(coordinationDir, "legacy-migration.lock")
    const staleToken = randomUUID()
    mkdirSync(coordinationDir)
    writeFileSync(guardPath, JSON.stringify({ pid: 2_147_483_647, token: staleToken }))

    const lease = await Effect.runPromise(acquireCoordinationLock(guardPath))

    expect(lease.token).not.toBe(staleToken)
    expect(JSON.parse(readFileSync(guardPath, "utf8"))).toEqual({ pid: lease.pid, token: lease.token })
    await Effect.runPromise(releaseStateRootLock(lease))
  })

  it("does not release a replacement migration guard", async () => {
    const guardPath = join(dir, ".expand-locks", "legacy-migration.lock")
    const oldLease = await Effect.runPromise(acquireOwnershipLock(guardPath))
    rmSync(guardPath)
    const replacement = await Effect.runPromise(acquireOwnershipLock(guardPath))

    await Effect.runPromise(releaseStateRootLock(oldLease))

    expect(JSON.parse(readFileSync(guardPath, "utf8"))).toEqual({
      pid: replacement.pid,
      token: replacement.token
    })
    await Effect.runPromise(releaseStateRootLock(replacement))
  })

  it("fails unresolved default migration before creating the target or root lock", async () => {
    const legacyDir = join(dir, ".expand")
    const defaultDir = join(legacyDir, "expand-dev")
    const guardPath = join(dir, ".expand-locks", "legacy-migration.lock")
    mkdirSync(join(legacyDir, "other-channel"), { recursive: true })
    writeFileSync(join(legacyDir, "events.db"), "legacy-db")

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.result(startupOwnership(appPaths(defaultDir), {
          defaultDir,
          legacyDir,
          migrationLockFile: guardPath
        }))
      ).pipe(Effect.provide(BunFileSystem.layer))
    )

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "DefaultHomeMigrationError",
        recoverablePath: join(legacyDir, "events.db")
      }
    })
    expect(existsSync(defaultDir)).toBe(false)
    expect(existsSync(join(defaultDir, "backend.lock"))).toBe(false)
    expect(existsSync(guardPath)).toBe(false)
  })

  it("fails with an unresolved staging path before creating the target or root lock", async () => {
    const legacyDir = join(dir, ".expand")
    const defaultDir = join(legacyDir, "expand-dev")
    const stage = `${legacyDir}.migrating-expand-dev`
    const guardPath = join(dir, ".expand-locks", "legacy-migration.lock")
    mkdirSync(legacyDir)
    mkdirSync(stage)
    writeFileSync(join(legacyDir, "marker"), "new")
    writeFileSync(join(stage, "events.db"), "legacy-db")

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.result(startupOwnership(appPaths(defaultDir), {
          defaultDir,
          legacyDir,
          migrationLockFile: guardPath
        }))
      ).pipe(Effect.provide(BunFileSystem.layer))
    )

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "DefaultHomeMigrationError", recoverablePath: stage }
    })
    expect(existsSync(defaultDir)).toBe(false)
    expect(existsSync(join(defaultDir, "backend.lock"))).toBe(false)
    expect(existsSync(stage)).toBe(true)
    expect(existsSync(guardPath)).toBe(false)
  })
})

const appPaths = (dataDir: string): AppPath => ({
  dataDir,
  dbPath: join(dataDir, "events.db"),
  endpointFile: join(dataDir, "server.json"),
  logDir: join(dataDir, "logs"),
  spawnLockFile: join(dataDir, "server.json.lock")
})
