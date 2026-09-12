import { layer as effectLayer } from "@effect/vitest"
import { expect } from "vitest"
import { ProcessServices } from "../process-services"
import {
  Cause,
  Clock,
  Context,
  Crypto,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Path,
  PlatformError,
  Queue,
  Schedule,
  Schema,
  Stream
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { AppContext, makeAppContext } from "@expand/contracts/app-context"
import { EndpointFromJson } from "@expand/contracts/endpoint"
import { PROTOCOL_VERSION } from "@expand/contracts/rpc/version"
import {
  ProcessControl,
  ProcessProbeError,
  type ProcessControlShape
} from "@expand/contracts/process-control"
import { BackendUnavailable } from "../../errors"
import { findOrSpawnBackend } from "../../spawn"
import {
  acquireSpawnLock,
  releaseSpawnLock,
  type SpawnLockLease,
  type SpawnLockOptions
} from "../../spawn-lock"
import { makeNodeAdapter } from "../../adapters/node"

const nodeAdapter = makeNodeAdapter({
  backendCommand: Effect.succeed(["node", "--import", "tsx", "apps/server/main.ts"])
})

class TestDirectory extends Context.Service<TestDirectory, string>()("expand/SpawnLockTest/Directory") {}

const TestDirectoryLive = Layer.effect(
  TestDirectory,
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix: "expand-client-lock-" }))
  )
)

const TestLayer = TestDirectoryLive.pipe(Layer.provideMerge(ProcessServices.layer))

effectLayer(TestLayer, { excludeTestServices: true, timeout: "2 minutes" })("client spawn lock", (test) => {
  test.effect("elects exactly one of 64 real processes for a fresh lock", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* TestDirectory
      const lockPath = path.join(dir, "fresh", "server.json.lock")
      const results = yield* runContenders(lockPath, 64)

      expect(results.filter(({ status }) => status === "acquired")).toHaveLength(1)
      expect(yield* fs.exists(lockPath)).toBe(false)
    }), 60_000)

  test.effect("elects exactly one of 64 real processes for a valid dead current owner", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const cryptoService = yield* Crypto.Crypto
      const dir = yield* TestDirectory
      const lockPath = path.join(dir, "stale", "server.json.lock")
      yield* fs.makeDirectory(path.dirname(lockPath))
      yield* writeCurrentRecord(lockPath, {
        pid: 2_147_483_647,
        startedAt: (yield* Clock.currentTimeMillis) - 60_000,
        token: yield* cryptoService.randomUUIDv4
      })

      const results = yield* runContenders(lockPath, 64)

      expect(results.filter(({ status }) => status === "acquired")).toHaveLength(1)
      expect(yield* fs.exists(lockPath)).toBe(false)
    }), 60_000)

  test.effect("never publishes an incomplete canonical record", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* TestDirectory
      const lockServices = yield* Effect.context<
        FileSystem.FileSystem | Path.Path | Crypto.Crypto | ProcessControl
      >()
      const lockPath = path.join(dir, "publication", "server.json.lock")
      let candidatePath: string | undefined
      let candidateRecord: CurrentRecord | undefined

      const lease = yield* acquireSpawnLock(lockPath, {
        beforePublish: (candidate) => Effect.gen(function*() {
          candidatePath = candidate
          expect(yield* fs.exists(lockPath)).toBe(false)
          expect((yield* fs.stat(candidate)).mode & 0o777).toBe(0o600)
          candidateRecord = yield* readCurrentRecord(candidate)
        }).pipe(Effect.provide(lockServices), Effect.orDie)
      })

      expect(lease).toBeDefined()
      expect(candidatePath).toBeDefined()
      expect(candidateRecord).toEqual({ pid: lease?.pid, startedAt: lease?.startedAt, token: lease?.token })
      expect(yield* readCurrentRecord(lockPath)).toEqual({
        pid: lease?.pid,
        startedAt: lease?.startedAt,
        token: lease?.token
      })
      if (candidatePath !== undefined) expect(yield* fs.exists(candidatePath)).toBe(false)
      if (lease !== undefined) yield* releaseSpawnLock(lease)
    }))

  test.effect("does not let a delayed stale observer unlink a replacement", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const cryptoService = yield* Crypto.Crypto
      const dir = yield* TestDirectory
      const lockServices = yield* Effect.context<
        FileSystem.FileSystem | Path.Path | Crypto.Crypto | ProcessControl
      >()
      const lockPath = path.join(dir, "delayed.lock")
      yield* writeCurrentRecord(lockPath, {
        pid: 2_147_483_647,
        startedAt: (yield* Clock.currentTimeMillis) - 60_000,
        token: yield* cryptoService.randomUUIDv4
      })
      let replacement: SpawnLockLease | undefined

      const delayed = yield* acquireSpawnLock(lockPath, {
        afterObservation: fs.remove(lockPath).pipe(
          Effect.andThen(acquireSpawnLock(lockPath).pipe(Effect.orDie)),
          Effect.tap((lease) => Effect.sync(() => {
            replacement = lease
          })),
          Effect.asVoid,
          Effect.provide(lockServices),
          Effect.orDie
        )
      })

      expect(delayed).toBeUndefined()
      expect(replacement).toBeDefined()
      expect(yield* readCurrentRecord(lockPath)).toMatchObject({ token: replacement?.token })
      if (replacement !== undefined) yield* releaseSpawnLock(replacement)
    }))

  test.effect("preserves a replacement when an old owner releases", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* TestDirectory
      const lockPath = path.join(dir, "release.lock")
      const oldLease = yield* acquireSpawnLock(lockPath)
      expect(oldLease).toBeDefined()
      yield* fs.remove(lockPath)
      const replacement = yield* acquireSpawnLock(lockPath)
      expect(replacement).toBeDefined()
      const replacementStat = yield* fs.stat(lockPath)

      if (oldLease !== undefined) yield* releaseSpawnLock(oldLease)

      expect(yield* readCurrentRecord(lockPath)).toMatchObject({ token: replacement?.token })
      expect(yield* fs.stat(lockPath)).toMatchObject({ dev: replacementStat.dev, ino: replacementStat.ino })
      if (replacement !== undefined) yield* releaseSpawnLock(replacement)
    }))

  test.effect("fails closed when the canonical owner is replaced during reclaim", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const cryptoService = yield* Crypto.Crypto
      const dir = yield* TestDirectory
      const lockServices = yield* Effect.context<
        FileSystem.FileSystem | Path.Path | Crypto.Crypto | ProcessControl
      >()
      const lockPath = path.join(dir, "reclaim.lock")
      yield* writeCurrentRecord(lockPath, {
        pid: 2_147_483_647,
        startedAt: (yield* Clock.currentTimeMillis) - 60_000,
        token: yield* cryptoService.randomUUIDv4
      })
      let replacement: SpawnLockLease | undefined

      const contender = yield* acquireSpawnLock(lockPath, {
        afterClaim: fs.remove(lockPath).pipe(
          Effect.andThen(acquireSpawnLock(lockPath).pipe(Effect.orDie)),
          Effect.tap((lease) => Effect.sync(() => {
            replacement = lease
          })),
          Effect.asVoid,
          Effect.provide(lockServices),
          Effect.orDie
        )
      })

      expect(contender).toBeUndefined()
      expect(replacement).toBeDefined()
      const replacementStat = yield* fs.stat(lockPath)
      expect(yield* readCurrentRecord(lockPath)).toMatchObject({ token: replacement?.token })
      expect(yield* fs.stat(lockPath)).toMatchObject({ dev: replacementStat.dev, ino: replacementStat.ino })
      if (replacement !== undefined) yield* releaseSpawnLock(replacement)
    }))

  test.effect("leaves malformed ownership evidence untouched", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* TestDirectory
      const lockPath = path.join(dir, "malformed.lock")
      yield* fs.writeFileString(lockPath, "{")
      const malformedStat = yield* fs.stat(lockPath)

      expect(yield* acquireSpawnLock(lockPath)).toBeUndefined()
      expect(yield* fs.readFileString(lockPath)).toBe("{")
      expect(yield* fs.stat(lockPath)).toMatchObject({ dev: malformedStat.dev, ino: malformedStat.ino })
    }))

  test.effect("does not steal a live current owner because of age", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      const cryptoService = yield* Crypto.Crypto
      const processControl = yield* ProcessControl
      const dir = yield* TestDirectory
      const lockPath = path.join(dir, "live.lock")
      const record = {
        pid: processControl.currentPid,
        startedAt: 1,
        token: yield* cryptoService.randomUUIDv4
      }
      yield* writeCurrentRecord(lockPath, record)

      expect(yield* acquireSpawnLock(lockPath)).toBeUndefined()
      expect(yield* readCurrentRecord(lockPath)).toEqual(record)
    }))

  test.effect("treats an inaccessible process as a live owner", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      const cryptoService = yield* Crypto.Crypto
      const dir = yield* TestDirectory
      const lockPath = path.join(dir, "eperm.lock")
      const record = { pid: 424_242, startedAt: 1, token: yield* cryptoService.randomUUIDv4 }
      yield* writeCurrentRecord(lockPath, record)

      expect(yield* acquireSpawnLock(lockPath).pipe(
        Effect.provideService(ProcessControl, processControl(() => Effect.succeed("inaccessible")))
      )).toBeUndefined()
      expect(yield* readCurrentRecord(lockPath)).toEqual(record)
    }))

  test.effect("recovers a dead tokenless legacy owner", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* TestDirectory
      const lockPath = path.join(dir, "legacy-dead.lock")
      yield* fs.writeFileString(lockPath, legacyRecordText(2_147_483_647, 1))

      const lease = yield* acquireSpawnLock(lockPath)

      expect(lease).toBeDefined()
      expect(yield* readCurrentRecord(lockPath)).toMatchObject({ token: lease?.token })
      if (lease !== undefined) yield* releaseSpawnLock(lease)
    }))

  test.effect("does not steal a live tokenless legacy owner", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const processControl = yield* ProcessControl
      const dir = yield* TestDirectory
      const lockPath = path.join(dir, "legacy-live.lock")
      const record = { pid: processControl.currentPid, startedAt: 1 }
      const encoded = yield* Schema.encodeEffect(LegacyRecordFromJson)(record)
      yield* fs.writeFileString(lockPath, encoded)

      expect(yield* acquireSpawnLock(lockPath)).toBeUndefined()
      expect(yield* readLegacyRecord(lockPath)).toEqual(record)
    }))

  test.effect("cleans its lease after success", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const processControl = yield* ProcessControl
      const dir = yield* TestDirectory
      const context = makeTestAppContext(path.join(dir, "success"), path)
      yield* fs.makeDirectory(context.paths.dataDir)
      const encoded = yield* Schema.encodeEffect(EndpointFromJson)(liveEndpoint("success", processControl.currentPid))
      const adapter = {
        ...nodeAdapter,
        spawnBackend: () => fs.writeFileString(context.paths.endpointFile, encoded).pipe(Effect.orDie)
      }

      yield* findOrSpawnBackend(adapter).pipe(Effect.provideService(AppContext, context))

      expect(yield* fs.exists(context.paths.spawnLockFile)).toBe(false)
      expect(yield* lockArtifactsEffect(context.paths.spawnLockFile)).toEqual([])
    }))

  test.effect("cleans its lease after a spawn error", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* TestDirectory
      const context = makeTestAppContext(path.join(dir, "error"), path)
      yield* fs.makeDirectory(context.paths.dataDir)
      const adapter = {
        ...nodeAdapter,
        spawnBackend: () => Effect.fail(new BackendUnavailable({ reason: "expected" }))
      }

      yield* findOrSpawnBackend(adapter).pipe(
        Effect.provideService(AppContext, context),
        Effect.result
      )

      expect(yield* fs.exists(context.paths.spawnLockFile)).toBe(false)
      expect(yield* lockArtifactsEffect(context.paths.spawnLockFile)).toEqual([])
    }))

  test.effect("cleans its lease after interruption", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* TestDirectory
      const context = makeTestAppContext(path.join(dir, "interruption"), path)
      yield* fs.makeDirectory(context.paths.dataDir)
      const spawning = yield* Queue.unbounded<void>()
      const adapter = {
        ...nodeAdapter,
        spawnBackend: () => Queue.offer(spawning, undefined).pipe(Effect.andThen(Effect.never))
      }
      const fiber = yield* Effect.forkChild(
        findOrSpawnBackend(adapter).pipe(Effect.provideService(AppContext, context))
      )
      yield* Queue.take(spawning)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)

      expect(yield* fs.exists(context.paths.spawnLockFile)).toBe(false)
      expect(yield* lockArtifactsEffect(context.paths.spawnLockFile)).toEqual([])
    }))

  test.effect("keeps different lock paths independent and secures their directories", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* TestDirectory
      const leftPath = path.join(dir, "left", "server.json.lock")
      const rightPath = path.join(dir, "right", "server.json.lock")
      const [left, right] = yield* Effect.all([acquireSpawnLock(leftPath), acquireSpawnLock(rightPath)], {
        concurrency: "unbounded"
      })

      expect(left).toBeDefined()
      expect(right).toBeDefined()
      expect((yield* fs.stat(path.join(dir, "left"))).mode & 0o777).toBe(0o700)
      expect((yield* fs.stat(leftPath)).mode & 0o777).toBe(0o600)
      expect((yield* fs.stat(path.join(dir, "right"))).mode & 0o777).toBe(0o700)
      expect((yield* fs.stat(rightPath)).mode & 0o777).toBe(0o600)
      if (left !== undefined) yield* releaseSpawnLock(left)
      if (right !== undefined) yield* releaseSpawnLock(right)
    }))

  test.effect("reports a directory creation failure instead of pretending contention", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      const dir = yield* TestDirectory
      const lockPath = path.join(dir, "directory-failure", "server.json.lock")
      const parent = path.dirname(lockPath)
      const cause = platformFailure("PermissionDenied", "makeDirectory", parent)
      const result = yield* acquireSpawnLock(lockPath).pipe(
        Effect.provide(FileSystem.layerNoop({
          makeDirectory: () => Effect.fail(cause)
        })),
        Effect.result
      )

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "SpawnLockError",
          kind: "filesystem",
          operation: "makeDirectory",
          path: parent,
          cause
        }
      })
    }))

  test.effect.each([
    ["link", "link"],
    ["readFileString", "readFileString"]
  ] as const)("reports an unexpected %s failure", ([method, operation]) =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* TestDirectory
      const lockPath = path.join(dir, `${method}-failure.lock`)
      const cause = platformFailure("PermissionDenied", method, lockPath)
      if (method === "readFileString") {
        yield* fs.writeFileString(lockPath, currentRecordText(100, 1, VALID_TOKEN))
      }
      const result = yield* acquireWithFileSystem(lockPath, (fileSystem) => method === "link"
        ? { link: () => Effect.fail(cause) }
        : { readFileString: () => Effect.fail(cause), link: fileSystem.link }).pipe(Effect.result)

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "SpawnLockError",
          kind: "filesystem",
          operation,
          path: lockPath,
          cause
        }
      })
    }))

  test.effect("reports a candidate cleanup failure", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      const dir = yield* TestDirectory
      const lockPath = path.join(dir, "remove-failure.lock")
      const cause = platformFailure("PermissionDenied", "remove", lockPath)
      const result = yield* acquireWithFileSystem(lockPath, (fs) => ({
        remove: (artifact, options) => artifact.includes(".candidate.")
          ? Effect.fail(cause)
          : fs.remove(artifact, options)
      })).pipe(Effect.result)

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "SpawnLockError",
          kind: "filesystem",
          operation: "remove",
          path: expect.stringContaining(".candidate."),
          cause
        }
      })
    }))

  test.effect("reports a UUID failure", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      const dir = yield* TestDirectory
      const lockPath = path.join(dir, "uuid-failure.lock")
      const cause = platformFailure("Unknown", "randomUUIDv4", lockPath)
      const result = yield* acquireWithCrypto(lockPath, (crypto) => Crypto.Crypto.of({
        ...crypto,
        randomUUIDv4: Effect.fail(cause)
      })).pipe(Effect.result)

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "SpawnLockError",
          kind: "crypto",
          operation: "randomUUIDv4",
          path: lockPath,
          cause
        }
      })
    }))

  test.effect("reports a legacy fingerprint digest failure", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* TestDirectory
      const lockPath = path.join(dir, "digest-failure.lock")
      const cause = platformFailure("Unknown", "digest", lockPath)
      yield* fs.writeFileString(lockPath, legacyRecordText(424_242, 1))
      const result = yield* acquireWithCrypto(
        lockPath,
        (crypto) => Crypto.Crypto.of({ ...crypto, digest: () => Effect.fail(cause) }),
        {},
        processControl(() => Effect.succeed("dead"))
      ).pipe(Effect.result)

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "SpawnLockError",
          kind: "digest",
          operation: "legacyFingerprint",
          path: lockPath,
          cause
        }
      })
    }))

  test.effect("reports an invalid injected pid as an internal schema failure", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      const dir = yield* TestDirectory
      const lockPath = path.join(dir, "schema-failure.lock")
      const result = yield* acquireEffect(
        lockPath,
        {},
        processControl(() => Effect.succeed("alive"), 0)
      ).pipe(Effect.result)

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "SpawnLockError",
          kind: "schema",
          operation: "encodeCurrentRecord",
          path: lockPath,
          cause: expect.anything()
        }
      })
    }))

  test.effect("reports an unexpected process probe failure", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* TestDirectory
      const lockPath = path.join(dir, "probe-failure.lock")
      const cause = { reason: "unexpected process failure" }
      const probeError = new ProcessProbeError({ pid: 424_242, cause })
      yield* fs.writeFileString(lockPath, currentRecordText(424_242, 1, VALID_TOKEN))
      const result = yield* acquireEffect(
        lockPath,
        {},
        processControl(() => Effect.fail(probeError))
      ).pipe(Effect.result)

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "SpawnLockError",
          kind: "probe",
          operation: "probe",
          path: lockPath,
          cause: probeError
        }
      })
    }))

  test.effect("runs Effect hooks lazily", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* TestDirectory
      const freshPath = path.join(dir, "lazy-publish.lock")
      let publications = 0
      const fresh = acquireEffect(freshPath, {
        beforePublish: () => Effect.sync(() => {
          publications += 1
        })
      })
      expect(publications).toBe(0)
      const freshLease = yield* fresh
      expect(publications).toBe(1)

      const stalePath = path.join(dir, "lazy-reclaim.lock")
      yield* fs.writeFileString(stalePath, currentRecordText(424_242, 1, VALID_TOKEN))
      let observations = 0
      let claims = 0
      const stale = acquireEffect(stalePath, {
        afterObservation: Effect.sync(() => {
          observations += 1
        }),
        afterClaim: Effect.sync(() => {
          claims += 1
        })
      }, processControl(() => Effect.succeed("dead")))
      expect(observations).toBe(0)
      expect(claims).toBe(0)
      const staleLease = yield* stale
      expect(observations).toBe(1)
      expect(claims).toBe(1)

      if (freshLease !== undefined) yield* releaseSpawnLock(freshLease)
      if (staleLease !== undefined) yield* releaseSpawnLock(staleLease)
    }))

  test.effect.each([
    ["beforePublish", (defect: unknown): SpawnLockOptions => ({ beforePublish: () => Effect.die(defect) })],
    ["afterObservation", (defect: unknown): SpawnLockOptions => ({ afterObservation: Effect.die(defect) })],
    ["afterClaim", (defect: unknown): SpawnLockOptions => ({ afterClaim: Effect.die(defect) })]
  ] as const)("keeps a %s hook defect in the surrounding Effect", ([name, options]) =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* TestDirectory
      const lockPath = path.join(dir, `${name}-defect.lock`)
      if (name !== "beforePublish") {
        yield* fs.writeFileString(lockPath, currentRecordText(424_242, 1, VALID_TOKEN))
      }
      const defect = { name, reason: "hook defect" }
      const exit = yield* Effect.exit(
        acquireEffect(lockPath, options(defect), processControl(() => Effect.succeed("dead")))
      )
      const artifacts = yield* lockArtifactsEffect(lockPath)

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(artifacts).toEqual([])
    }))

  test.effect("removes its candidate when interrupted before publication", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* TestDirectory
      const lockPath = path.join(dir, "interrupted-publication.lock")
      const fiber = yield* Effect.forkChild(
        acquireEffect(lockPath, { beforePublish: () => Effect.never })
      )
      yield* waitForArtifact(lockPath, ".candidate.")
      yield* Fiber.interrupt(fiber)

      expect(yield* fs.exists(lockPath)).toBe(false)
      expect(yield* lockArtifactsEffect(lockPath)).toEqual([])
    }))

  test.effect("removes its claim when interrupted after claiming", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* TestDirectory
      const lockPath = path.join(dir, "interrupted-claim.lock")
      const original = currentRecordText(424_242, 1, VALID_TOKEN)
      yield* fs.writeFileString(lockPath, original)
      const fiber = yield* Effect.forkChild(
        acquireEffect(
          lockPath,
          { afterClaim: Effect.never },
          processControl(() => Effect.succeed("dead"))
        )
      )
      yield* waitForArtifact(lockPath, ".claim.")
      yield* Fiber.interrupt(fiber)

      expect(yield* fs.readFileString(lockPath)).toBe(original)
      expect(yield* lockArtifactsEffect(lockPath)).toEqual([])
    }))

  test.effect.each([
    ["current-extra", `{"pid":1,"startedAt":1,"token":"${VALID_TOKEN}","extra":true}`],
    ["legacy-extra", "{\"pid\":1,\"startedAt\":1,\"extra\":true}"],
    ["zero-pid", `{"pid":0,"startedAt":1,"token":"${VALID_TOKEN}"}`],
    ["fractional-pid", `{"pid":1.5,"startedAt":1,"token":"${VALID_TOKEN}"}`],
    ["negative-time", `{"pid":1,"startedAt":-1,"token":"${VALID_TOKEN}"}`],
    ["fractional-time", `{"pid":1,"startedAt":1.5,"token":"${VALID_TOKEN}"}`],
    ["invalid-token", "{\"pid\":1,\"startedAt\":1,\"token\":\"not-a-uuid\"}"]
  ] as const)("leaves invalid ownership evidence untouched", ([name, text]) =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* TestDirectory
      const lockPath = path.join(dir, `invalid-${name}.lock`)
      yield* fs.writeFileString(lockPath, text)
      const originalStat = yield* fs.stat(lockPath)

      expect(yield* acquireSpawnLock(lockPath)).toBeUndefined()
      expect(yield* fs.readFileString(lockPath)).toBe(text)
      expect(yield* fs.stat(lockPath)).toMatchObject({ dev: originalStat.dev, ino: originalStat.ino })
    }))

  test.effect("maps a held-lease cleanup failure through BackendUnavailable", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const processControl = yield* ProcessControl
      const dir = yield* TestDirectory
      const context = makeTestAppContext(path.join(dir, "cleanup-map"), path)
      yield* fs.makeDirectory(context.paths.dataDir, { recursive: true })
      const endpoint = liveEndpoint("cleanup-map", processControl.currentPid)
      const encoded = yield* Schema.encodeEffect(EndpointFromJson)(endpoint)
      const cause = platformFailure("PermissionDenied", "remove", context.paths.spawnLockFile)
      const adapter = {
        ...nodeAdapter,
        spawnBackend: () => fs.writeFileString(context.paths.endpointFile, encoded).pipe(Effect.orDie)
      }
      const overridden = FileSystem.FileSystem.of({
        ...fs,
        remove: (artifact, options) => artifact === context.paths.spawnLockFile
          ? Effect.fail(cause)
          : fs.remove(artifact, options)
      })
      const result = yield* findOrSpawnBackend(adapter).pipe(
        Effect.provideService(FileSystem.FileSystem, overridden),
        Effect.provideService(AppContext, context),
        Effect.result
      )

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "BackendUnavailable",
          reason: expect.stringContaining("spawn lock remove failed")
        }
      })
    }))
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
const ContenderResultSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal("contended") }),
  Schema.Struct({
    status: Schema.Literal("acquired"),
    pid: PositiveSafeInteger,
    token: UuidV4
  })
])
const CurrentRecordFromJson = Schema.fromJsonString(CurrentRecordSchema)
const LegacyRecordFromJson = Schema.fromJsonString(LegacyRecordSchema)
const ContenderResultFromJson = Schema.fromJsonString(ContenderResultSchema)

type CurrentRecord = typeof CurrentRecordSchema.Type
type ContenderResult = typeof ContenderResultSchema.Type

const strictParseOptions = { onExcessProperty: "error" } as const

const acquireEffect = Effect.fn("SpawnLockTest.acquire")(function*(
  lockPath: string,
  options: SpawnLockOptions = {},
  service?: ProcessControlShape
) {
  const effect = acquireSpawnLock(lockPath, options)
  return service === undefined
    ? yield* effect
    : yield* effect.pipe(Effect.provideService(ProcessControl, service))
})

const acquireWithFileSystem = Effect.fn("SpawnLockTest.acquireWithFileSystem")(function*(
  lockPath: string,
  override: (fs: FileSystem.FileSystem) => Partial<FileSystem.FileSystem>,
  options: SpawnLockOptions = {},
  service?: ProcessControlShape
) {
  const fs = yield* FileSystem.FileSystem
  const effect = acquireSpawnLock(lockPath, options).pipe(
    Effect.provideService(FileSystem.FileSystem, FileSystem.FileSystem.of({
      ...fs,
      ...override(fs)
    }))
  )
  return service === undefined
    ? yield* effect
    : yield* effect.pipe(Effect.provideService(ProcessControl, service))
})

const acquireWithCrypto = Effect.fn("SpawnLockTest.acquireWithCrypto")(function*(
  lockPath: string,
  override: (crypto: Crypto.Crypto) => Crypto.Crypto,
  options: SpawnLockOptions = {},
  service?: ProcessControlShape
) {
  const cryptoService = yield* Crypto.Crypto
  const effect = acquireSpawnLock(lockPath, options).pipe(
    Effect.provideService(Crypto.Crypto, override(cryptoService))
  )
  return service === undefined
    ? yield* effect
    : yield* effect.pipe(Effect.provideService(ProcessControl, service))
})

const processControl = (
  probe: ProcessControlShape["probe"],
  currentPid = 100
): ProcessControlShape => ({
  currentPid,
  probe,
  currentIdentity: () => Effect.succeed(undefined),
  identify: (pid) =>
    Effect.gen(function*() {
      const status = yield* probe(pid)
      if (status === "alive") return { status: "alive" as const, identity: undefined }
      if (status === "dead") return { status: "dead" as const }
      return { status: "inaccessible" as const, identity: undefined }
    })
})

const platformFailure = (
  tag: PlatformError.SystemErrorTag,
  method: string,
  path: string
) => PlatformError.systemError({
  _tag: tag,
  module: "FileSystem",
  method,
  pathOrDescriptor: path
})

const VALID_TOKEN = "00000000-0000-4000-8000-000000000000"

const currentRecordText = (pid: number, startedAt: number, token: string) =>
  `{"pid":${pid},"startedAt":${startedAt},"token":"${token}"}`

const legacyRecordText = (pid: number, startedAt: number) =>
  `{"pid":${pid},"startedAt":${startedAt}}`

const writeCurrentRecord = Effect.fn("SpawnLockTest.writeCurrentRecord")(function*(
  path: string,
  record: CurrentRecord
) {
  const fs = yield* FileSystem.FileSystem
  const encoded = yield* Schema.encodeEffect(CurrentRecordFromJson, strictParseOptions)(record)
  yield* fs.writeFileString(path, encoded)
})

const readCurrentRecord = Effect.fn("SpawnLockTest.readCurrentRecord")(function*(path: string) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(path)
  return yield* Schema.decodeUnknownEffect(CurrentRecordFromJson, strictParseOptions)(text)
})

const readLegacyRecord = Effect.fn("SpawnLockTest.readLegacyRecord")(function*(path: string) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(path)
  return yield* Schema.decodeUnknownEffect(LegacyRecordFromJson, strictParseOptions)(text)
})

const lockArtifactsEffect = Effect.fn("SpawnLockTest.lockArtifacts")(function*(lockPath: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const parent = path.dirname(lockPath)
  const prefix = lockPath.slice(parent.length + 1)
  const entries = yield* fs.readDirectory(parent)
  return entries.filter((entry) => entry.startsWith(`${prefix}.`))
})

const waitForArtifact = Effect.fn("SpawnLockTest.waitForArtifact")(function*(
  lockPath: string,
  marker: string
) {
  yield* lockArtifactsEffect(lockPath).pipe(
    Effect.filterOrFail(
      (artifacts) => artifacts.some((artifact) => artifact.includes(marker)),
      () => "pending" as const
    ),
    Effect.retry(Schedule.spaced("2 millis")),
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () => Effect.fail(`timed out waiting for ${marker}` as const)
    }),
    Effect.asVoid
  )
})

const runContenders = Effect.fn("SpawnLockTest.runContenders")(function*(
  lockPath: string,
  count: number
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const cryptoService = yield* Crypto.Crypto
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const dir = yield* TestDirectory
  const root = path.resolve(".")
  const contenderPath = path.join(root, "packages/client-ts/test/fixtures/spawn-lock-contender.ts")
  const coordinationDir = path.join(dir, `coordination-${yield* cryptoService.randomUUIDv4}`)
  const startPath = path.join(coordinationDir, "start")
  const releasePath = path.join(coordinationDir, "release")
  yield* fs.makeDirectory(coordinationDir)

  return yield* Effect.acquireUseRelease(
    Effect.forEach(Array.from({ length: count }, (_, index) => index), (index) =>
      Effect.gen(function*() {
        const readyPath = path.join(coordinationDir, `ready-${index}`)
        const resultPath = path.join(coordinationDir, `result-${index}`)
        const handle = yield* spawner.spawn(ChildProcess.make(
          "node",
          ["--import", "tsx", contenderPath, lockPath, readyPath, startPath, releasePath, resultPath],
          {
            cwd: root,
            detached: false,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "pipe"
          }
        ))
        const stderr = yield* handle.stderr.pipe(
          Stream.decodeText(),
          Stream.mkString,
          Effect.forkScoped
        )
        return { readyPath, resultPath, handle, stderr }
      })),
    (processes) => Effect.gen(function*() {
      yield* waitForAllPaths(processes.map(({ readyPath }) => readyPath))
      yield* fs.writeFileString(startPath, "start")
      yield* waitForAllPaths(processes.map(({ resultPath }) => resultPath))
      return yield* Effect.forEach(processes, ({ resultPath }) =>
        fs.readFileString(resultPath).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(ContenderResultFromJson, strictParseOptions))
        ))
    }),
    (processes) => Effect.gen(function*() {
      yield* fs.writeFileString(startPath, "start")
      yield* fs.writeFileString(releasePath, "release")
      const exits = yield* Effect.forEach(processes, ({ handle, stderr }) =>
        Effect.all([handle.exitCode, Fiber.join(stderr)]), { concurrency: "unbounded" })
      yield* Effect.forEach(exits, ([exitCode, stderr]) => Number(exitCode) === 0
        ? Effect.void
        : Effect.fail(`spawn-lock contender failed with ${String(exitCode)}: ${stderr}`))
    })
  )
})

const waitForAllPaths = Effect.fn("SpawnLockTest.waitForAllPaths")(function*(paths: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem
  yield* Effect.forEach(paths, (path) => fs.exists(path), { concurrency: "unbounded" }).pipe(
    Effect.filterOrFail((exists) => exists.every(Boolean), () => "pending" as const),
    Effect.retry(Schedule.spaced("2 millis")),
    Effect.timeoutOrElse({
      duration: "45 seconds",
      orElse: () => Effect.fail("coordination timed out" as const)
    }),
    Effect.asVoid
  )
})

const liveEndpoint = (token: string, pid: number) => ({
  url: "ws://127.0.0.1:51991/rpc",
  token,
  pid,
  protocolVersion: PROTOCOL_VERSION
})

const makeTestAppContext = (dataDir: string, path: Path.Path) =>
  makeAppContext(path, { homeDir: dataDir, cwd: dataDir, dataDir })
