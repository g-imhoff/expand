import { NodeServices } from "@effect/platform-node"
import { layer as effectLayer } from "@effect/vitest"
import { Clock, Context, Deferred, Effect, Fiber, FileSystem, Layer, Option, Path, Queue, Schema } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"
import { makeTempDirectoryScoped } from "../../../../test/support/effect-files"
import { ProcessServices } from "../process-services"
import { findOrSpawnBackend } from "../../spawn"
import { makeNodeAdapter } from "../../adapters/node"
import { AppContext, makeAppContext } from "@expand/contracts/app-context"
import { type Endpoint, EndpointFromJson, PROTOCOL_VERSION } from "@expand/contracts/endpoint"
import { ProcessControl } from "@expand/contracts/process-control"
import { BackendUnavailable } from "../../errors"

class TestDirectory extends Context.Service<TestDirectory, string>()("expand/FindOrSpawnTest/Directory") {}

const TestDirectoryLive = Layer.effect(
  TestDirectory,
  makeTempDirectoryScoped("expand-spawn-")
).pipe(Layer.provide(NodeServices.layer))

const TestLayer = Layer.mergeAll(TestDirectoryLive, ProcessServices.layer, NodeServices.layer)

const nodeAdapter = makeNodeAdapter({
  backendCommand: Effect.succeed(["node", "--import", "tsx", "apps/server/main.ts"])
})
const reviverOwnedAdapter = {
  protocolLayer: nodeAdapter.protocolLayer,
  spawnBackend: () => Effect.void
}

const SpawnLockRecordFromJson = Schema.fromJsonString(Schema.Struct({
  pid: Schema.Number,
  startedAt: Schema.Number
}))

effectLayer(TestLayer, { excludeTestServices: true })("findOrSpawnBackend", (it) => {
  const context = (name: string) => Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const directory = path.join(yield* TestDirectory, name)
    yield* fs.makeDirectory(directory)
    return makeTestAppContext(directory, path)
  })

  it.effect("returns the existing live backend without spawning", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const processControl = yield* ProcessControl
      const appContext = yield* context("existing")
      const advertisedEndpoint = yield* Schema.encodeEffect(EndpointFromJson)({
        url: "ws://127.0.0.1:51789/rpc",
        token: "t",
        pid: processControl.currentPid,
        protocolVersion: PROTOCOL_VERSION
      })
      yield* fs.writeFileString(appContext.paths.endpointFile, advertisedEndpoint)
      const endpoint = yield* findOrSpawnBackend(nodeAdapter).pipe(
        Effect.provideService(AppContext, appContext)
      )
      expect(endpoint.url).toBe("ws://127.0.0.1:51789/rpc")
      expect(endpoint.pid).toBe(processControl.currentPid)
    }))

  it.effect("spawns once for concurrent callers using the same state root", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const processControl = yield* ProcessControl
      const appContext = yield* context("concurrent")
      let spawnCount = 0
      const endpoint = {
        url: "ws://127.0.0.1:51792/rpc",
        token: "same-root",
        pid: processControl.currentPid,
        protocolVersion: PROTOCOL_VERSION
      }
      const adapter = {
        ...nodeAdapter,
        spawnBackend: () => Effect.gen(function*() {
          spawnCount += 1
          yield* Effect.sleep("25 millis")
          const advertisedEndpoint = yield* Schema.encodeEffect(EndpointFromJson)(endpoint)
          yield* fs.writeFileString(appContext.paths.endpointFile, advertisedEndpoint)
        }).pipe(Effect.orDie)
      }
      const endpoints = yield* Effect.all(
        [findOrSpawnBackend(adapter), findOrSpawnBackend(adapter)],
        { concurrency: "unbounded" }
      ).pipe(Effect.provideService(AppContext, appContext))
      expect(spawnCount).toBe(1)
      expect(endpoints).toEqual([endpoint, endpoint])
    }))

  it.effect("re-elects a contender after the elected spawner fails without advertising", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const processControl = yield* ProcessControl
      const appContext = yield* context("failed-owner-takeover")
      const releaseOwner = yield* Queue.unbounded<void>()
      const contenderObserved = yield* Queue.unbounded<void>()
      let spawnAttempts = 0
      let takeoverSpawns = 0
      const endpoint = {
        url: "ws://127.0.0.1:51796/rpc",
        token: "takeover",
        pid: processControl.currentPid,
        protocolVersion: PROTOCOL_VERSION
      }
      const adapter = {
        ...nodeAdapter,
        spawnBackend: () => Effect.gen(function*() {
          spawnAttempts += 1
          if (spawnAttempts === 1) {
            yield* Queue.take(releaseOwner)
            return yield* new BackendUnavailable({ reason: "elected spawner failed" })
          }
          takeoverSpawns += 1
          const advertisedEndpoint = yield* Schema.encodeEffect(EndpointFromJson)(endpoint).pipe(Effect.orDie)
          yield* fs.writeFileString(appContext.paths.endpointFile, advertisedEndpoint).pipe(Effect.orDie)
        })
      }
      const observedFs = FileSystem.FileSystem.of({
        ...fs,
        link: (existingPath, newPath) => fs.link(existingPath, newPath).pipe(
          Effect.tapError(() => spawnAttempts === 1 && newPath === appContext.paths.spawnLockFile
            ? Queue.offer(contenderObserved, undefined)
            : Effect.void)
        )
      })
      const owner = yield* findOrSpawnBackend(adapter).pipe(
        Effect.provideService(FileSystem.FileSystem, observedFs),
        Effect.provideService(AppContext, appContext),
        Effect.forkChild
      )
      while (spawnAttempts === 0) yield* Effect.yieldNow
      const contender = yield* findOrSpawnBackend(adapter).pipe(
        Effect.provideService(FileSystem.FileSystem, observedFs),
        Effect.provideService(AppContext, appContext),
        Effect.forkChild
      )
      yield* Queue.take(contenderObserved)
      yield* Queue.offer(releaseOwner, undefined)
      const ownerExit = yield* Fiber.join(owner).pipe(Effect.result)
      const contenderResult = yield* Fiber.join(contender).pipe(Effect.timeout("2 seconds"))
      expect(spawnAttempts).toBe(2)
      expect(ownerExit).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "BackendUnavailable", reason: "elected spawner failed" }
      })
      expect(contenderResult).toEqual(endpoint)
      expect(takeoverSpawns).toBe(1)
    }))

  it.effect("holds the default external lease without creating the nested target before spawn", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const processControl = yield* ProcessControl
      const dir = path.join(yield* TestDirectory, "external")
      const dataDir = path.join(dir, ".expand", "expand-dev")
      const appContext = makeTestAppContext(dataDir, path)
      const externalLock = path.join(dir, ".expand-locks", "expand-dev.spawn.lock")
      const paths = { ...appContext.paths, spawnLockFile: externalLock }
      const endpoint = {
        url: "ws://127.0.0.1:51795/rpc",
        token: "external-default",
        pid: processControl.currentPid,
        protocolVersion: PROTOCOL_VERSION
      }
      const adapter = {
        ...nodeAdapter,
        spawnBackend: () => Effect.gen(function*() {
          expect(yield* fs.exists(dataDir)).toBe(false)
          expect(yield* fs.exists(externalLock)).toBe(true)
          yield* fs.makeDirectory(dataDir, { recursive: true })
          const advertisedEndpoint = yield* Schema.encodeEffect(EndpointFromJson)(endpoint)
          yield* fs.writeFileString(paths.endpointFile, advertisedEndpoint)
        }).pipe(Effect.orDie)
      }
      const actual = yield* findOrSpawnBackend(adapter).pipe(
        Effect.provideService(AppContext, { channel: appContext.channel, paths })
      )
      expect(actual).toEqual(endpoint)
      expect(yield* fs.exists(externalLock)).toBe(false)
    }))

  it.effect("spawns independently for different state roots", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const processControl = yield* ProcessControl
      const dir = path.join(yield* TestDirectory, "independent")
      const leftRoot = path.join(dir, "left")
      const rightRoot = path.join(dir, "right")
      const spawnedRoots: Array<string> = []
      const adapter = {
        ...nodeAdapter,
        spawnBackend: (dataDir: string) => Effect.gen(function*() {
          spawnedRoots.push(dataDir)
          const target = makeTestAppContext(dataDir, path).paths.endpointFile
          const advertisedEndpoint = yield* Schema.encodeEffect(EndpointFromJson)({
            url: `ws://127.0.0.1:${dataDir === leftRoot ? 51793 : 51794}/rpc`,
            token: dataDir,
            pid: processControl.currentPid,
            protocolVersion: PROTOCOL_VERSION
          })
          yield* fs.writeFileString(target, advertisedEndpoint)
        }).pipe(Effect.orDie)
      }
      yield* Effect.all([
        findOrSpawnBackend(adapter).pipe(
          Effect.provideService(AppContext, makeTestAppContext(leftRoot, path))
        ),
        findOrSpawnBackend(adapter).pipe(
          Effect.provideService(AppContext, makeTestAppContext(rightRoot, path))
        )
      ], { concurrency: "unbounded" })
      expect(new Set(spawnedRoots)).toEqual(new Set([leftRoot, rightRoot]))
    }))

  it.effect("waits for a valid endpoint advertised at six seconds", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const processControl = yield* ProcessControl
      const appContext = yield* context("six-seconds")
      const realEndpoint = {
        url: "ws://127.0.0.1:51791/rpc",
        token: "slow-start",
        pid: processControl.currentPid,
        protocolVersion: PROTOCOL_VERSION
      }
      const postSpawnPollCompleted = yield* Queue.unbounded<void>()
      const advertiserAwake = yield* Deferred.make<void>()
      const finderCompleted = yield* Deferred.make<Endpoint, BackendUnavailable | ProbeFailure>()
      let backendSpawned = false
      const adapter = {
        ...nodeAdapter,
        spawnBackend: () => Effect.sync(() => {
          backendSpawned = true
        })
      }
      const observedFs = FileSystem.FileSystem.of({
        ...fs,
        exists: (target) => fs.exists(target).pipe(
          Effect.tap(() => backendSpawned
            ? Queue.offer(postSpawnPollCompleted, undefined)
            : Effect.void)
        )
      })
      const advertiser = yield* Effect.sleep("6 seconds").pipe(
        Effect.andThen(Deferred.succeed(advertiserAwake, undefined)),
        Effect.andThen(Schema.encodeEffect(EndpointFromJson)(realEndpoint)),
        Effect.flatMap((encoded) => fs.writeFileString(appContext.paths.endpointFile, encoded)),
        Effect.forkChild
      )
      const finderCompletion = yield* Deferred.complete(
        finderCompleted,
        findOrSpawnBackend(adapter).pipe(
          Effect.provideService(FileSystem.FileSystem, observedFs),
          Effect.provideService(AppContext, appContext)
        )
      ).pipe(Effect.forkChild)
      yield* Queue.take(postSpawnPollCompleted)
      yield* TestClock.adjust("6 seconds")
      expect(Option.isSome(yield* Deferred.poll(advertiserAwake))).toBe(true)
      yield* Fiber.join(advertiser)
      expect(Option.isNone(yield* Deferred.poll(finderCompleted))).toBe(true)
      yield* TestClock.adjust("100 millis")
      yield* Fiber.join(finderCompletion)
      const endpoint = yield* Option.getOrThrow(yield* Deferred.poll(finderCompleted))
      expect(endpoint.url).toBe(realEndpoint.url)
    }).pipe(Effect.provide(TestClock.layer())))

  it.effect("fails when the backend has not advertised by thirty seconds", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const appContext = yield* context("thirty-seconds")
      const postSpawnPollCompleted = yield* Queue.unbounded<void>()
      let backendSpawned = false
      const adapter = {
        ...nodeAdapter,
        spawnBackend: () => Effect.sync(() => {
          backendSpawned = true
        })
      }
      const observedFs = FileSystem.FileSystem.of({
        ...fs,
        exists: (target) => fs.exists(target).pipe(
          Effect.tap(() => backendSpawned
            ? Queue.offer(postSpawnPollCompleted, undefined)
            : Effect.void)
        )
      })
      const completed = yield* Deferred.make<Endpoint, BackendUnavailable | ProbeFailure>()
      yield* Deferred.complete(
        completed,
        findOrSpawnBackend(adapter).pipe(
          Effect.provideService(FileSystem.FileSystem, observedFs),
          Effect.provideService(AppContext, appContext)
        )
      ).pipe(Effect.forkChild)
      yield* Queue.take(postSpawnPollCompleted)
      yield* TestClock.adjust("29 seconds")
      const beforeDeadline = yield* Deferred.poll(completed)
      yield* TestClock.adjust("1 second")
      const result = yield* Deferred.await(completed).pipe(Effect.result)
      expect(Option.isNone(beforeDeadline)).toBe(true)
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "BackendUnavailable", reason: "backend did not start in time" }
      })
    }).pipe(Effect.provide(TestClock.layer())))

  it.effect("recovers from a stale (dead-pid) spawn lock with no server.json", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const processControl = yield* ProcessControl
      const appContext = yield* context("stale-lock")
      const lockPath = appContext.paths.spawnLockFile
      const staleLock = yield* Schema.encodeEffect(SpawnLockRecordFromJson)({
        pid: 2_147_483_647,
        startedAt: yield* Clock.currentTimeMillis
      })
      yield* fs.writeFileString(lockPath, staleLock)
      const realEndpoint = {
        url: "ws://127.0.0.1:51790/rpc",
        token: "fresh",
        pid: processControl.currentPid,
        protocolVersion: PROTOCOL_VERSION
      }
      const encodedEndpoint = yield* Schema.encodeEffect(EndpointFromJson)(realEndpoint)
      const reviver = yield* fs.writeFileString(
        appContext.paths.endpointFile,
        encodedEndpoint
      ).pipe(Effect.delay("100 millis"), Effect.forkChild)
      const endpoint = yield* findOrSpawnBackend(reviverOwnedAdapter).pipe(
        Effect.provideService(AppContext, appContext)
      )
      yield* Fiber.join(reviver)
      expect(endpoint.url).toBe(realEndpoint.url)
      expect(yield* fs.exists(lockPath)).toBe(false)
    }))
})

const makeTestAppContext = (dataDir: string, path: Path.Path) =>
  makeAppContext(path, { homeDir: dataDir, cwd: dataDir, dataDir })

type ProbeFailure = import("@expand/contracts/process-control").ProcessProbeError | "pending"
