import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Deferred, Effect, Fiber, FileSystem, Option } from "effect"
import { TestClock } from "effect/testing"
import { NodeServices } from "@effect/platform-node"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findOrSpawnBackend } from "../../spawn"
import { makeNodeAdapter } from "../../adapters/node"
import { AppContext, makeAppContext } from "@expand/contracts/app-context"
import { type Endpoint, PROTOCOL_VERSION } from "@expand/contracts/endpoint"
import { Layer } from "effect"
import type { BackendUnavailable } from "../../errors"

let dir: string
const nodeAdapter = makeNodeAdapter({
  backendCommand: [process.execPath, "--import", "tsx", join(process.cwd(), "apps/server/main.ts")]
})
const reviverOwnedAdapter = {
  protocolLayer: nodeAdapter.protocolLayer,
  spawnBackend: () => Effect.void
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "expand-spawn-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("findOrSpawnBackend", () => {
  it("returns the existing live backend without spawning", async () => {
    writeFileSync(
      makeAppContext(dir).paths.endpointFile,
      JSON.stringify({
        url: "ws://127.0.0.1:51789/rpc",
        token: "t",
        pid: process.pid,
        protocolVersion: PROTOCOL_VERSION
      })
    )
    const endpoint = await Effect.runPromise(
      Effect.provide(findOrSpawnBackend(nodeAdapter), Layer.mergeAll(NodeServices.layer, Layer.succeed(AppContext, makeAppContext(dir))))
    )
    expect(endpoint.url).toBe("ws://127.0.0.1:51789/rpc")
    expect(endpoint.pid).toBe(process.pid)
  })

  it("spawns once for concurrent callers using the same state root", async () => {
    let spawnCount = 0
    const endpoint = {
      url: "ws://127.0.0.1:51792/rpc",
      token: "same-root",
      pid: process.pid,
      protocolVersion: PROTOCOL_VERSION
    }
    const adapter = {
      ...nodeAdapter,
      spawnBackend: (dataDir: string) => Effect.gen(function* () {
        spawnCount += 1
        yield* Effect.sleep("25 millis")
        writeFileSync(makeAppContext(dataDir).paths.endpointFile, JSON.stringify(endpoint))
      })
    }

    const endpoints = await Effect.runPromise(
      Effect.all(
        [findOrSpawnBackend(adapter), findOrSpawnBackend(adapter)],
        { concurrency: "unbounded" }
      ).pipe(
        Effect.provide(NodeServices.layer),
        Effect.provide(Layer.succeed(AppContext, makeAppContext(dir)))
      )
    )

    expect(spawnCount).toBe(1)
    expect(endpoints).toEqual([endpoint, endpoint])
  })

  it("holds the default external lease without creating the nested target before spawn", async () => {
    const dataDir = join(dir, ".expand", "expand-dev")
    const context = makeAppContext(dataDir)
    const externalLock = join(dir, ".expand-locks", "expand-dev.spawn.lock")
    const paths = { ...context.paths, spawnLockFile: externalLock }
    const endpoint = {
      url: "ws://127.0.0.1:51795/rpc",
      token: "external-default",
      pid: process.pid,
      protocolVersion: PROTOCOL_VERSION
    }
    const adapter = {
      ...nodeAdapter,
      spawnBackend: () => Effect.sync(() => {
        expect(existsSync(dataDir)).toBe(false)
        expect(existsSync(externalLock)).toBe(true)
        mkdirSync(dataDir, { recursive: true })
        writeFileSync(paths.endpointFile, JSON.stringify(endpoint))
      })
    }

    const actual = await Effect.runPromise(
      findOrSpawnBackend(adapter).pipe(
        Effect.provide(NodeServices.layer),
        Effect.provide(Layer.succeed(AppContext, { channel: context.channel, paths }))
      )
    )

    expect(actual).toEqual(endpoint)
    expect(existsSync(externalLock)).toBe(false)
  })

  it("spawns independently for different state roots", async () => {
    const leftRoot = join(dir, "left")
    const rightRoot = join(dir, "right")
    const spawnedRoots: Array<string> = []
    const adapter = {
      ...nodeAdapter,
      spawnBackend: (dataDir: string) => Effect.sync(() => {
        spawnedRoots.push(dataDir)
        writeFileSync(
          makeAppContext(dataDir).paths.endpointFile,
          JSON.stringify({
            url: `ws://127.0.0.1:${dataDir === leftRoot ? 51793 : 51794}/rpc`,
            token: dataDir,
            pid: process.pid,
            protocolVersion: PROTOCOL_VERSION
          })
        )
      })
    }

    await Effect.runPromise(
      Effect.all(
        [
          findOrSpawnBackend(adapter).pipe(Effect.provide(Layer.succeed(AppContext, makeAppContext(leftRoot)))),
          findOrSpawnBackend(adapter).pipe(Effect.provide(Layer.succeed(AppContext, makeAppContext(rightRoot))))
        ],
        { concurrency: "unbounded" }
      ).pipe(Effect.provide(NodeServices.layer))
    )

    expect(new Set(spawnedRoots)).toEqual(new Set([leftRoot, rightRoot]))
  })

  it("waits for a valid endpoint advertised at six seconds", async () => {
    const realEndpoint = {
      url: "ws://127.0.0.1:51791/rpc",
      token: "slow-start",
      pid: process.pid,
      protocolVersion: PROTOCOL_VERSION
    }

    const program = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const postSpawnPollCompleted = yield* Deferred.make<void>()
      let backendSpawned = false
      const adapter = {
        ...nodeAdapter,
        spawnBackend: () => Effect.sync(() => {
          backendSpawned = true
        })
      }
      const observedFs = FileSystem.FileSystem.of({
        ...fs,
        exists: (path) => fs.exists(path).pipe(
          Effect.tap(() => backendSpawned
            ? Deferred.succeed(postSpawnPollCompleted, undefined)
            : Effect.void)
        )
      })
      const advertiser = yield* Effect.sleep("6 seconds").pipe(
        Effect.andThen(
          Effect.sync(() => writeFileSync(makeAppContext(dir).paths.endpointFile, JSON.stringify(realEndpoint)))
        ),
        Effect.forkChild
      )
      const finder = yield* findOrSpawnBackend(adapter).pipe(
        Effect.provideService(FileSystem.FileSystem, observedFs),
        Effect.forkChild
      )
      yield* Deferred.await(postSpawnPollCompleted)
      yield* TestClock.adjust("6 seconds")
      yield* TestClock.adjust("100 millis")
      const endpoint = yield* Fiber.join(finder)
      yield* Fiber.join(advertiser)
      return endpoint
    }).pipe(
      Effect.provide(TestClock.layer()),
      Effect.provide(NodeServices.layer),
      Effect.provide(Layer.succeed(AppContext, makeAppContext(dir)))
    )

    const endpoint = await Effect.runPromise(program)
    expect(endpoint.url).toBe(realEndpoint.url)
  })

  it("fails when the backend has not advertised by thirty seconds", async () => {
    const program = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const postSpawnPollCompleted = yield* Deferred.make<void>()
      let backendSpawned = false
      const adapter = {
        ...nodeAdapter,
        spawnBackend: () => Effect.sync(() => {
          backendSpawned = true
        })
      }
      const observedFs = FileSystem.FileSystem.of({
        ...fs,
        exists: (path) => fs.exists(path).pipe(
          Effect.tap(() => backendSpawned
            ? Deferred.succeed(postSpawnPollCompleted, undefined)
            : Effect.void)
        )
      })
      const completed = yield* Deferred.make<Endpoint, BackendUnavailable | "pending">()
      yield* Deferred.complete(
        completed,
        findOrSpawnBackend(adapter).pipe(Effect.provideService(FileSystem.FileSystem, observedFs))
      ).pipe(Effect.forkChild)
      yield* Deferred.await(postSpawnPollCompleted)
      yield* TestClock.adjust("29 seconds")
      const beforeDeadline = yield* Deferred.poll(completed)
      yield* TestClock.adjust("1 second")
      const result = yield* Deferred.await(completed).pipe(Effect.result)
      return { beforeDeadline, result }
    }).pipe(
      Effect.provide(TestClock.layer()),
      Effect.provide(NodeServices.layer),
      Effect.provide(Layer.succeed(AppContext, makeAppContext(dir)))
    )

    const { beforeDeadline, result } = await Effect.runPromise(program)
    expect(Option.isNone(beforeDeadline)).toBe(true)
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "BackendUnavailable", reason: "backend did not start in time" }
    })
  })

  // Regression for the stale-spawn-lock wedge: a spawner SIGKILLed AFTER acquiring
  // `<endpoint>.lock` but BEFORE advertising `server.json` would orphan the lock
  // forever, so every later command failed with BackendUnavailable and never
  // re-spawned (pre-fix). The acquire must now detect the dead-pid lock as stale,
  // clear it, and proceed to spawn instead of waiting out the timeout and failing.
  it("recovers from a stale (dead-pid) spawn lock with no server.json", async () => {
    const lockPath = makeAppContext(dir).paths.spawnLockFile
    // Orphaned lock: a dead pid (out-of-range -> ESRCH -> treated as dead). No
    // server.json exists, so readEndpoint is None and we go straight to acquire.
    writeFileSync(lockPath, JSON.stringify({ pid: 2147483647, startedAt: Date.now() }))

    const realEndpoint = {
      url: "ws://127.0.0.1:51790/rpc",
      token: "fresh",
      pid: process.pid,
      protocolVersion: PROTOCOL_VERSION
    }

    const program = Effect.gen(function* () {
      // Stand in for the freshly-spawned server: once the acquire has cleared the
      // stale lock and (no-op) spawn fires, advertise a live endpoint so the
      // acquiring fiber's awaitEndpoint resolves instead of timing out.
      const reviver = yield* Effect.forkChild(
        Effect.sync(() => writeFileSync(makeAppContext(dir).paths.endpointFile, JSON.stringify(realEndpoint))).pipe(
          Effect.delay("100 millis")
        )
      )
      // Pre-fix: this would wait the full 10s awaitEndpoint window and then fail
      // with BackendUnavailable, never clearing the lock. Post-fix: it clears the
      // stale lock, "spawns", and returns the advertised endpoint.
      const endpoint = yield* findOrSpawnBackend(reviverOwnedAdapter)
      yield* Fiber.join(reviver)
      return endpoint
    }).pipe(Effect.provide(NodeServices.layer), Effect.provide(Layer.succeed(AppContext, makeAppContext(dir))))

    const endpoint = await Effect.runPromise(program)
    expect(endpoint.url).toBe(realEndpoint.url)
    // The stale lock was cleared (acquired then released via Effect.ensuring).
    expect(existsSync(lockPath)).toBe(false)
  })
})
