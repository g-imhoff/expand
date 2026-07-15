import { layer as effectLayer } from "@effect/vitest"
import { expect, expectTypeOf } from "vitest"
import { TestClock } from "effect/testing"
import {
  Cause,
  Clock,
  Crypto,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Option,
  Path,
  PlatformError,
  Queue,
  Schedule,
  Schema,
  Scope,
  Stream
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import {
  ProcessControl,
  ProcessProbeError,
  type ProcessControlShape
} from "@expand/contracts/process-control"
import { ProcessServices } from "@expand/server/node-process-control"
import {
  acquireStateRootLock,
  releaseStateRootLock,
  type StateRootLease,
  StateRootLockError,
  type StateRootLockOptions,
  stateRootLock,
  stateRootLockForStartup
} from "@expand/server/state-root-lock"

effectLayer(ProcessServices.layer, { excludeTestServices: true, timeout: "2 minutes" })("state root ownership (I-2)", (test) => {
  test("exposes typed lock errors and service environments", () => {
    const acquire = acquireStateRootLock("/state")
    const release = releaseStateRootLock({ path: "/state/backend.lock", pid: 1, token: VALID_TOKEN })
    const scoped = stateRootLock("/state")
    const startup = stateRootLockForStartup("/state", "/state/server.json")

    expectTypeOf<Effect.Error<typeof acquire>>().toEqualTypeOf<StateRootLockError>()
    expectTypeOf<Effect.Services<typeof acquire>>().toEqualTypeOf<
      FileSystem.FileSystem | Path.Path | Crypto.Crypto | ProcessControl
    >()
    expectTypeOf<Effect.Error<typeof release>>().toEqualTypeOf<StateRootLockError>()
    expectTypeOf<Effect.Services<typeof release>>().toEqualTypeOf<FileSystem.FileSystem>()
    expectTypeOf<Effect.Error<typeof scoped>>().toEqualTypeOf<StateRootLockError>()
    expectTypeOf<Effect.Services<typeof scoped>>().toEqualTypeOf<
      FileSystem.FileSystem | Path.Path | Crypto.Crypto | ProcessControl | Scope.Scope
    >()
    expectTypeOf<Effect.Error<typeof startup>>().toEqualTypeOf<StateRootLockError>()
    expectTypeOf<Effect.Services<typeof startup>>().toEqualTypeOf<
      FileSystem.FileSystem | Path.Path | Crypto.Crypto | ProcessControl | Scope.Scope
    >()
  })

  test.effect("constructs startup ownership lazily", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const cryptoService = yield* Crypto.Crypto
      const clock = yield* Clock.Clock
      const dir = yield* makeTestDirectory()
      const counts = { path: 0, crypto: 0, pid: 0, clock: 0, fs: 0, hook: 0 }
      const trackedPath = Path.Path.of({
        ...path,
        join: (...parts) => {
          counts.path += 1
          return path.join(...parts)
        },
        resolve: (...parts) => {
          counts.path += 1
          return path.resolve(...parts)
        }
      })
      const trackedCrypto = Crypto.Crypto.of({
        ...cryptoService,
        randomUUIDv4: Effect.sync(() => {
          counts.crypto += 1
          return VALID_TOKEN
        })
      })
      const trackedProcess: ProcessControlShape = {
        get currentPid() {
          counts.pid += 1
          return 4242
        },
        probe: () => Effect.succeed("alive")
      }
      const trackedClock: Clock.Clock = {
        currentTimeMillis: Effect.sync(() => {
          counts.clock += 1
          return 1_000
        }),
        currentTimeMillisUnsafe: () => {
          counts.clock += 1
          return 1_000
        },
        currentTimeNanos: clock.currentTimeNanos,
        currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
        sleep: (duration) => clock.sleep(duration)
      }
      const trackedFileSystem = FileSystem.FileSystem.of({
        ...fs,
        makeDirectory: (target, options) => Effect.sync(() => {
          counts.fs += 1
        }).pipe(Effect.andThen(fs.makeDirectory(target, options)))
      })
      const dataDir = path.join(dir, "lazy")
      const program = stateRootLockForStartup(dataDir, path.join(dataDir, "server.json"), {
        beforePublish: () => Effect.sync(() => {
          counts.hook += 1
        })
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, trackedFileSystem),
        Effect.provideService(Path.Path, trackedPath),
        Effect.provideService(Crypto.Crypto, trackedCrypto),
        Effect.provideService(ProcessControl, trackedProcess),
        Effect.provideService(Clock.Clock, trackedClock),
        Effect.scoped
      )

      expect(counts).toEqual({ path: 0, crypto: 0, pid: 0, clock: 0, fs: 0, hook: 0 })
      const lease = yield* program
      expect(lease).toMatchObject({ pid: 4242, token: VALID_TOKEN })
      expect(counts.path).toBeGreaterThan(0)
      expect(counts.crypto).toBe(1)
      expect(counts.pid).toBe(1)
      expect(counts.clock).toBe(1)
      expect(counts.fs).toBeGreaterThan(0)
      expect(counts.hook).toBe(1)
    }))

  test.effect("rejects a second live owner for the same state root", () =>
    Effect.gen(function*() {
      const dir = yield* makeTestDirectory()
      const first = yield* acquireStateRootLock(dir)
      const error = yield* acquireStateRootLock(dir).pipe(Effect.flip)

      expect(error).toBeInstanceOf(StateRootLockError)
      expect(error).toMatchObject({ dataDir: dir, kind: "live-owner", ownerPid: first.pid })
      yield* releaseStateRootLock(first)
    }))

  test.effect("waits for an unadvertised live owner to release before acquiring", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      const dir = yield* makeTestDirectory()
      const endpointFile = path.join(dir, "server.json")
      const first = yield* acquireStateRootLock(dir)
      const second = yield* Effect.scoped(
        Effect.gen(function*() {
          const fiber = yield* Effect.forkChild(stateRootLockForStartup(dir, endpointFile))
          yield* Effect.yieldNow
          expect(fiber.pollUnsafe()).toBeUndefined()
          expect(yield* readOwner(first.path)).toMatchObject({ token: first.token })
          yield* releaseStateRootLock(first)
          return yield* Fiber.join(fiber)
        })
      )

      expect(second.token).not.toBe(first.token)
    }))

  test.effect("rejects promptly when an endpoint is already advertised", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* makeTestDirectory()
      const endpointFile = path.join(dir, "server.json")
      const first = yield* acquireStateRootLock(dir)
      yield* fs.writeFileString(endpointFile, "{}")

      const error = yield* Effect.scoped(
        stateRootLockForStartup(dir, endpointFile).pipe(Effect.flip)
      )

      expect(error).toMatchObject({ kind: "endpoint-advertised" })
      expect(yield* readOwner(first.path)).toMatchObject({ token: first.token })
      yield* releaseStateRootLock(first)
    }))

  test.effect("returns a handoff timeout using the Effect clock", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      const dir = yield* makeTestDirectory()
      const endpointFile = path.join(dir, "server.json")
      const first = yield* acquireStateRootLock(dir)
      const reachedPublication = yield* Queue.unbounded<void>()
      const fiber = yield* Effect.forkChild(
        Effect.scoped(
          stateRootLockForStartup(dir, endpointFile, {
            beforePublish: () => Queue.offer(reachedPublication, undefined)
          }).pipe(Effect.flip)
        )
      )
      yield* TestClock.testClockWith((clock) => clock.withLive(
        awaitSignal(Queue.take(reachedPublication))
      ))
      yield* TestClock.adjust("4 seconds")
      const error = yield* Fiber.join(fiber)

      expect(error).toMatchObject({ kind: "handoff-timeout", ownerPid: first.pid })
      expect(yield* readOwner(first.path)).toMatchObject({ token: first.token })
      yield* releaseStateRootLock(first)
    }).pipe(Effect.provide(TestClock.layer({ warningDelay: "10 seconds" }))))

  test.effect("interrupts startup scoped acquisition promptly during handoff", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const clock = yield* Clock.Clock
      const dir = yield* makeTestDirectory()
      const endpointFile = path.join(dir, "server.json")
      const first = yield* acquireStateRootLock(dir)
      const handoff = yield* Queue.unbounded<void>()
      const trackingClock: Clock.Clock = {
        currentTimeMillis: clock.currentTimeMillis,
        currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
        currentTimeNanos: clock.currentTimeNanos,
        currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
        sleep: (duration) => Queue.offer(handoff, undefined).pipe(
          Effect.andThen(clock.sleep(duration))
        )
      }
      const fiber = yield* Effect.forkChild(
        Effect.scoped(stateRootLockForStartup(dir, endpointFile)).pipe(
          Effect.provideService(Clock.Clock, trackingClock)
        )
      )
      yield* TestClock.testClockWith((testClock) => testClock.withLive(
        awaitSignal(Queue.take(handoff))
      ))
      const interrupter = yield* Effect.forkChild(Fiber.interrupt(fiber))
      const interruptedPromptly = yield* TestClock.testClockWith((testClock) => testClock.withLive(
        Fiber.join(interrupter).pipe(
          Effect.as(true),
          Effect.timeoutOrElse({
            duration: "500 millis",
            orElse: () => Effect.succeed(false)
          })
        )
      ))
      if (!interruptedPromptly) yield* TestClock.adjust("4 seconds")
      yield* Fiber.join(interrupter)

      expect(interruptedPromptly).toBe(true)
      expect(yield* readOwner(first.path)).toEqual({ pid: first.pid, token: first.token })
      expect(yield* lockArtifacts(first.path)).toEqual([])
      expect(yield* fs.exists(endpointFile)).toBe(false)
      yield* releaseStateRootLock(first)
    }).pipe(Effect.provide(TestClock.layer({ warningDelay: "10 seconds" }))))

  test.effect("acquires when only a stale endpoint remains", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const processControl = yield* ProcessControl
      const dir = yield* makeTestDirectory()
      const endpointFile = path.join(dir, "server.json")
      yield* fs.writeFileString(endpointFile, "stale")

      const lease = yield* Effect.scoped(stateRootLockForStartup(dir, endpointFile))

      expect(lease.pid).toBe(processControl.currentPid)
      expect(yield* fs.readFileString(endpointFile)).toBe("stale")
    }))

  test.effect("rejects before acquiring when an endpoint appears during handoff", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* makeTestDirectory()
      const endpointFile = path.join(dir, "server.json")
      const first = yield* acquireStateRootLock(dir)
      const reachedPublication = yield* Queue.unbounded<void>()
      const fiber = yield* Effect.forkChild(
        Effect.scoped(
          stateRootLockForStartup(dir, endpointFile, {
            beforePublish: () => Queue.offer(reachedPublication, undefined)
          }).pipe(Effect.flip)
        )
      )
      yield* TestClock.testClockWith((clock) => clock.withLive(
        awaitSignal(Queue.take(reachedPublication))
      ))
      yield* fs.writeFileString(endpointFile, "{}")
      yield* TestClock.adjust("50 millis")
      const error = yield* Fiber.join(fiber)

      expect(error).toMatchObject({ kind: "endpoint-advertised" })
      expect(yield* readOwner(first.path)).toMatchObject({ token: first.token })
      yield* releaseStateRootLock(first)
    }).pipe(Effect.provide(TestClock.layer({ warningDelay: "10 seconds" }))))

  test.effect("allows live owners for different state roots", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* makeTestDirectory()
      const otherDir = path.join(dir, "other")
      const first = yield* acquireStateRootLock(dir)
      const second = yield* acquireStateRootLock(otherDir)

      expect(first.path).toBe(path.join(dir, "backend.lock"))
      expect(second.path).toBe(path.join(otherDir, "backend.lock"))
      expect((yield* fs.stat(second.path)).mode & 0o777).toBe(0o600)
      expect((yield* fs.stat(otherDir)).mode & 0o777).toBe(0o700)
      yield* releaseStateRootLock(first)
      yield* releaseStateRootLock(second)
    }))

  test.effect("releases the scoped state root lease", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* makeTestDirectory()
      const lockPath = yield* Effect.scoped(
        Effect.gen(function*() {
          const lease = yield* stateRootLock(dir)
          expect(yield* fs.exists(lease.path)).toBe(true)
          return lease.path
        })
      )

      expect(yield* fs.exists(lockPath)).toBe(false)
    }))

  test.effect("restricts an existing permissive state root to owner access", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* makeTestDirectory()
      yield* fs.chmod(dir, 0o777)
      const lease = yield* acquireStateRootLock(dir)

      expect((yield* fs.stat(dir)).mode & 0o777).toBe(0o700)
      yield* releaseStateRootLock(lease)
    }))

  test.effect("elects exactly one real process for a fresh state root", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      const dir = yield* makeTestDirectory()
      const results = yield* runContenders(path.join(dir, "fresh"), 64)

      expect(results.filter(({ status }) => status === "acquired")).toHaveLength(1)
    }), 60_000)

  test.effect("fails closed instead of unlinking malformed canonical locks", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* makeTestDirectory()
      const lockPath = path.join(dir, "backend.lock")
      yield* fs.writeFileString(lockPath, "")
      const result = yield* Effect.result(acquireStateRootLock(dir))

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "StateRootLockError", cause: expect.anything() }
      })
      expect(yield* fs.readFileString(lockPath)).toBe("")
    }))

  test.effect.each([
    ["extra key", `{"pid":1,"token":"${VALID_TOKEN}","extra":true}`],
    ["zero pid", `{"pid":0,"token":"${VALID_TOKEN}"}`],
    ["unsafe pid", `{"pid":9007199254740992,"token":"${VALID_TOKEN}"}`],
    ["invalid UUID", "{\"pid\":1,\"token\":\"invalid\"}"],
    ["malformed JSON", "{"]
  ] as const)("preserves strictly invalid ownership evidence with an %s", ([, text]) =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* makeTestDirectory()
      const lockPath = path.join(dir, "backend.lock")
      yield* fs.writeFileString(lockPath, text)
      const original = yield* fs.stat(lockPath)
      const result = yield* Effect.result(acquireStateRootLock(dir))

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "StateRootLockError", cause: expect.anything() }
      })
      expect(yield* fs.readFileString(lockPath)).toBe(text)
      expect(yield* fs.stat(lockPath)).toMatchObject({ dev: original.dev, ino: original.ino })
    }))

  test.effect("recovers a lock whose owner is no longer alive", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      const processControl = yield* ProcessControl
      const cryptoService = yield* Crypto.Crypto
      const dir = yield* makeTestDirectory()
      const lockPath = path.join(dir, "backend.lock")
      const staleToken = yield* cryptoService.randomUUIDv4
      yield* writeOwner(lockPath, { pid: 2_147_483_647, token: staleToken })

      const lease = yield* acquireStateRootLock(dir)

      expect(lease.pid).toBe(processControl.currentPid)
      expect(lease.token).not.toBe(staleToken)
      yield* releaseStateRootLock(lease)
    }))

  test.effect("elects exactly one real process during concurrent stale recovery", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const cryptoService = yield* Crypto.Crypto
      const dir = yield* makeTestDirectory()
      const root = path.join(dir, "stale")
      yield* fs.makeDirectory(root)
      yield* writeOwner(path.join(root, "backend.lock"), {
        pid: 2_147_483_647,
        token: yield* cryptoService.randomUUIDv4
      })
      const results = yield* runContenders(root, 64)

      expect(results.filter(({ status }) => status === "acquired")).toHaveLength(1)
    }), 60_000)

  test.effect("does not remove a replacement owner's lock", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const cryptoService = yield* Crypto.Crypto
      const processControl = yield* ProcessControl
      const dir = yield* makeTestDirectory()
      const lease = yield* acquireStateRootLock(dir)
      const replacement = { pid: processControl.currentPid, token: yield* cryptoService.randomUUIDv4 }
      yield* fs.remove(lease.path)
      yield* writeOwner(lease.path, replacement)
      const replacementInfo = yield* fs.stat(lease.path)

      yield* releaseStateRootLock(lease)

      expect(yield* readOwner(lease.path)).toEqual(replacement)
      expect(yield* fs.stat(lease.path)).toMatchObject({ dev: replacementInfo.dev, ino: replacementInfo.ino })
    }))

  test.effect("injects deterministic process and UUID services after complete publication", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const cryptoService = yield* Crypto.Crypto
      const dir = yield* makeTestDirectory()
      let candidatePath: string | undefined
      const fixedProcess = processControl(() => Effect.succeed("alive"), 4242)
      const fixedCrypto = Crypto.Crypto.of({
        ...cryptoService,
        randomUUIDv4: Effect.succeed(VALID_TOKEN)
      })
      const lease = yield* acquireStateRootLock(dir, {
        beforePublish: (candidate) => Effect.gen(function*() {
          candidatePath = candidate
          expect(yield* fs.exists(path.join(path.resolve(dir), "backend.lock"))).toBe(false)
          expect((yield* fs.stat(candidate)).mode & 0o777).toBe(0o600)
          const candidateText = yield* fs.readFileString(candidate)
          const candidateOwner = yield* Schema.decodeUnknownEffect(
            LockOwnerFromJson,
            strictParseOptions
          )(candidateText)
          expect(candidateOwner).toEqual({ pid: 4242, token: VALID_TOKEN })
        }).pipe(Effect.orDie)
      }).pipe(
        Effect.provideService(ProcessControl, fixedProcess),
        Effect.provideService(Crypto.Crypto, fixedCrypto)
      )

      expect(lease).toEqual({ path: path.join(path.resolve(dir), "backend.lock"), pid: 4242, token: VALID_TOKEN })
      expect(yield* readOwner(lease.path)).toEqual({ pid: 4242, token: VALID_TOKEN })
      if (candidatePath !== undefined) expect(yield* fs.exists(candidatePath)).toBe(false)
      yield* releaseStateRootLock(lease)
    }))

  test.effect("treats an inaccessible process as a live owner", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      const dir = yield* makeTestDirectory()
      const lockPath = path.join(dir, "backend.lock")
      yield* writeOwner(lockPath, { pid: 424_242, token: VALID_TOKEN })
      const error = yield* acquireStateRootLock(dir).pipe(
        Effect.provideService(ProcessControl, processControl(() => Effect.succeed("inaccessible"))),
        Effect.flip
      )

      expect(error).toMatchObject({ kind: "live-owner", ownerPid: 424_242 })
      expect(yield* readOwner(lockPath)).toEqual({ pid: 424_242, token: VALID_TOKEN })
    }))

  test.effect("retains an unknown process probe failure without reclaiming", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      const dir = yield* makeTestDirectory()
      const lockPath = path.join(dir, "backend.lock")
      const cause = { reason: "unexpected process probe" }
      const probeError = new ProcessProbeError({ pid: 424_242, cause })
      yield* writeOwner(lockPath, { pid: 424_242, token: VALID_TOKEN })
      const result = yield* acquireStateRootLock(dir).pipe(
        Effect.provideService(ProcessControl, processControl(() => Effect.fail(probeError))),
        Effect.result
      )

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "StateRootLockError", cause: probeError }
      })
      expect(yield* readOwner(lockPath)).toEqual({ pid: 424_242, token: VALID_TOKEN })
    }))

  test.effect("retains a directory creation failure", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      const dir = yield* makeTestDirectory()
      const dataDir = path.join(dir, "directory-failure")
      const cause = platformFailure("PermissionDenied", "makeDirectory", dataDir)
      const result = yield* acquireStateRootLock(dataDir).pipe(
        Effect.provide(FileSystem.layerNoop({
          makeDirectory: () => Effect.fail(cause)
        })),
        Effect.result
      )

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "StateRootLockError", cause }
      })
    }))

  test.effect("retains UUID and internal record encoding failures", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      const cryptoService = yield* Crypto.Crypto
      const dir = yield* makeTestDirectory()
      const uuidCause = platformFailure("Unknown", "randomUUIDv4", path.join(dir, "backend.lock"))
      const uuidResult = yield* acquireStateRootLock(path.join(dir, "uuid")).pipe(
        Effect.provideService(Crypto.Crypto, Crypto.Crypto.of({
          ...cryptoService,
          randomUUIDv4: Effect.fail(uuidCause)
        })),
        Effect.result
      )
      const schemaRoot = path.join(dir, "schema")
      const schemaResult = yield* acquireStateRootLock(schemaRoot).pipe(
        Effect.provideService(ProcessControl, processControl(() => Effect.succeed("alive"), 0)),
        Effect.result
      )

      expect(uuidResult).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "StateRootLockError", cause: uuidCause }
      })
      expect(schemaResult).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "StateRootLockError", cause: expect.anything() }
      })
      expect(yield* lockArtifacts(path.join(schemaRoot, "backend.lock"))).toEqual([])
    }))

  test.effect("removes its candidate when interrupted before publication", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* makeTestDirectory()
      const reached = yield* Queue.unbounded<void>()
      const fiber = yield* Effect.forkChild(acquireStateRootLock(dir, {
        beforePublish: () => Queue.offer(reached, undefined).pipe(Effect.andThen(Effect.never))
      }))
      yield* awaitSignal(Queue.take(reached))
      yield* Fiber.interrupt(fiber)

      const lockPath = path.join(path.resolve(dir), "backend.lock")
      expect(yield* fs.exists(lockPath)).toBe(false)
      expect(yield* lockArtifacts(lockPath)).toEqual([])
    }))

  test.effect("interrupts regular scoped acquisition promptly before publication", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* makeTestDirectory()
      const reached = yield* Queue.unbounded<void>()
      const release = yield* Queue.unbounded<void>()
      let candidatePath: string | undefined
      const fiber = yield* Effect.forkChild(
        Effect.scoped(stateRootLock(dir, {
          beforePublish: (candidate) => Effect.sync(() => {
            candidatePath = candidate
          }).pipe(
            Effect.andThen(Queue.offer(reached, undefined)),
            Effect.andThen(Queue.take(release))
          )
        }))
      )
      yield* awaitSignal(Queue.take(reached))
      const interrupter = yield* Effect.forkChild(Fiber.interrupt(fiber))
      const interruptedPromptly = yield* Fiber.join(interrupter).pipe(
        Effect.as(true),
        Effect.timeoutOrElse({
          duration: "500 millis",
          orElse: () => Effect.succeed(false)
        })
      )
      yield* Queue.offer(release, undefined)
      yield* Fiber.join(interrupter)

      const lockPath = path.join(path.resolve(dir), "backend.lock")
      expect(interruptedPromptly).toBe(true)
      expect(candidatePath).toBeDefined()
      expect(yield* fs.exists(lockPath)).toBe(false)
      if (candidatePath !== undefined) expect(yield* fs.exists(candidatePath)).toBe(false)
      expect(yield* lockArtifacts(lockPath)).toEqual([])
    }))

  test.effect("removes its claim when interrupted after claiming", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* makeTestDirectory()
      const lockPath = path.join(dir, "backend.lock")
      const original = ownerText(424_242, VALID_TOKEN)
      yield* fs.writeFileString(lockPath, original)
      const reached = yield* Queue.unbounded<void>()
      const fiber = yield* Effect.forkChild(
        acquireStateRootLock(dir, {
          afterClaim: Queue.offer(reached, undefined).pipe(Effect.andThen(Effect.never))
        }).pipe(
          Effect.provideService(ProcessControl, processControl(() => Effect.succeed("dead")))
        )
      )
      yield* awaitSignal(Queue.take(reached))
      yield* Fiber.interrupt(fiber)

      expect(yield* fs.readFileString(lockPath)).toBe(original)
      expect(yield* lockArtifacts(lockPath)).toEqual([])
    }))

  test.effect.each([
    "open",
    "writeAll",
    "sync",
    "chmod",
    "link"
  ] as const)("retains a publication %s failure and removes the candidate", (method) =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      const dir = yield* makeTestDirectory()
      const lockPath = path.join(dir, "backend.lock")
      const cause = platformFailure("PermissionDenied", method, lockPath)
      const result = yield* acquireWithFileSystem(
        dir,
        (fs) => publicationFailure(fs, method, cause)
      ).pipe(Effect.result)

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "StateRootLockError", cause }
      })
      expect(yield* lockArtifacts(lockPath)).toEqual([])
    }))

  test.effect("retains a canonical read failure without reclaiming", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* makeTestDirectory()
      const lockPath = path.join(dir, "backend.lock")
      const original = ownerText(424_242, VALID_TOKEN)
      const cause = platformFailure("PermissionDenied", "readFileString", lockPath)
      yield* fs.writeFileString(lockPath, original)
      const result = yield* acquireWithFileSystem(dir, () => ({
        readFileString: () => Effect.fail(cause)
      })).pipe(Effect.result)

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "StateRootLockError", cause }
      })
      expect(yield* fs.readFileString(lockPath)).toBe(original)
      expect(yield* lockArtifacts(lockPath)).toEqual([])
    }))

  test.effect("reports initial observation disappearance as incomplete ownership evidence", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* makeTestDirectory()
      const lockPath = path.join(dir, "backend.lock")
      const alreadyExists = platformFailure("AlreadyExists", "link", lockPath)
      yield* fs.writeFileString(lockPath, ownerText(424_242, VALID_TOKEN))
      const result = yield* acquireWithFileSystem(dir, (fileSystem) => ({
        link: (from, to) => to === lockPath
          ? fileSystem.remove(lockPath).pipe(Effect.andThen(Effect.fail(alreadyExists)))
          : fileSystem.link(from, to)
      })).pipe(Effect.result)

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "StateRootLockError",
          reason: "state root ownership record is incomplete or invalid",
          cause: { reason: { _tag: "NotFound" } }
        }
      })
      expect(yield* fs.exists(lockPath)).toBe(false)
      expect(yield* lockArtifacts(lockPath)).toEqual([])
    }))

  test.effect("retains a claim stat failure and removes the owned claim", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* makeTestDirectory()
      const lockPath = path.join(dir, "backend.lock")
      const original = ownerText(424_242, VALID_TOKEN)
      const cause = platformFailure("PermissionDenied", "stat", lockPath)
      yield* fs.writeFileString(lockPath, original)
      const result = yield* acquireWithFileSystem(
        dir,
        () => ({ stat: () => Effect.fail(cause) }),
        {},
        processControl(() => Effect.succeed("dead"))
      ).pipe(Effect.result)

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "StateRootLockError", cause }
      })
      expect(yield* fs.readFileString(lockPath)).toBe(original)
      expect(yield* lockArtifacts(lockPath)).toEqual([])
    }))

  test.effect.each([
    ["beforePublish", (defect: unknown): StateRootLockOptions => ({
      beforePublish: () => Effect.die(defect)
    })],
    ["afterObservation", (defect: unknown): StateRootLockOptions => ({
      afterObservation: Effect.die(defect)
    })],
    ["afterClaim", (defect: unknown): StateRootLockOptions => ({
      afterClaim: Effect.die(defect)
    })]
  ] as const)("keeps an interruptible %s defect and cleans owned artifacts", ([name, makeOptions]) =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* makeTestDirectory()
      const lockPath = path.join(dir, "backend.lock")
      if (name !== "beforePublish") {
        yield* fs.writeFileString(lockPath, ownerText(424_242, VALID_TOKEN))
      }
      const defect = { name, reason: "hook defect" }
      const exit = yield* acquireStateRootLock(dir, makeOptions(defect)).pipe(
        Effect.provideService(ProcessControl, processControl(() => Effect.succeed("dead"))),
        Effect.exit
      )

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(yield* lockArtifacts(lockPath)).toEqual([])
      if (name === "beforePublish") expect(yield* fs.exists(lockPath)).toBe(false)
      else expect(yield* fs.readFileString(lockPath)).toBe(ownerText(424_242, VALID_TOKEN))
    }))

  test.effect("runs observation and claim hooks lazily", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* makeTestDirectory()
      const lockPath = path.join(dir, "backend.lock")
      yield* fs.writeFileString(lockPath, ownerText(424_242, VALID_TOKEN))
      let observations = 0
      let claims = 0
      const effect = acquireStateRootLock(dir, {
        afterObservation: Effect.sync(() => {
          observations += 1
        }),
        afterClaim: Effect.sync(() => {
          claims += 1
        })
      }).pipe(
        Effect.provideService(ProcessControl, processControl(() => Effect.succeed("dead")))
      )

      expect(observations).toBe(0)
      expect(claims).toBe(0)
      const lease = yield* effect
      expect(observations).toBe(1)
      expect(claims).toBe(1)
      expect(yield* lockArtifacts(lockPath)).toEqual([])
      yield* releaseStateRootLock(lease)
    }))

  test.effect("never removes a pre-existing losing contender claim", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* makeTestDirectory()
      const lockPath = path.join(dir, "backend.lock")
      const claimPath = `${lockPath}.reclaim.${VALID_TOKEN}`
      const original = ownerText(424_242, VALID_TOKEN)
      yield* fs.writeFileString(lockPath, original)
      yield* fs.writeFileString(claimPath, "other contender")
      const result = yield* acquireStateRootLock(dir).pipe(
        Effect.provideService(ProcessControl, processControl(() => Effect.succeed("dead"))),
        Effect.result
      )

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "StateRootLockError",
          reason: "state root ownership changed while the backend was starting"
        }
      })
      expect(yield* fs.readFileString(lockPath)).toBe(original)
      expect(yield* fs.readFileString(claimPath)).toBe("other contender")
    }))

  test.effect("treats a missing inode as insufficient identity proof", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* makeTestDirectory()
      const lockPath = path.join(dir, "backend.lock")
      const original = ownerText(424_242, VALID_TOKEN)
      yield* fs.writeFileString(lockPath, original)
      const result = yield* acquireWithFileSystem(
        dir,
        (fileSystem) => ({
          stat: (target) => fileSystem.stat(target).pipe(
            Effect.map((info) => target.includes(".reclaim.")
              ? { ...info, ino: Option.none() }
              : info)
          )
        }),
        {},
        processControl(() => Effect.succeed("dead"))
      ).pipe(Effect.result)

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "StateRootLockError",
          reason: "state root ownership changed while the backend was starting"
        }
      })
      expect(yield* fs.readFileString(lockPath)).toBe(original)
      expect(yield* lockArtifacts(lockPath)).toEqual([])
    }))

  test.effect.each([
    "afterObservation",
    "afterClaim"
  ] as const)("preserves a replacement installed %s", (phase) =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* makeTestDirectory()
      const lockPath = path.join(dir, "backend.lock")
      const original = ownerText(424_242, VALID_TOKEN)
      const replacement = ownerText(100, REPLACEMENT_TOKEN)
      yield* fs.writeFileString(lockPath, original)
      const installReplacement = fs.remove(lockPath).pipe(
        Effect.andThen(fs.writeFileString(lockPath, replacement)),
        Effect.andThen(fs.chmod(lockPath, 0o600))
      )
      const options: StateRootLockOptions = phase === "afterObservation"
        ? { afterObservation: installReplacement.pipe(Effect.orDie) }
        : { afterClaim: installReplacement.pipe(Effect.orDie) }
      const result = yield* acquireStateRootLock(dir, options).pipe(
        Effect.provideService(ProcessControl, processControl(() => Effect.succeed("dead"))),
        Effect.result
      )
      const replacementInfo = yield* fs.stat(lockPath)

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "StateRootLockError",
          reason: "state root ownership changed while the backend was starting"
        }
      })
      expect(yield* fs.readFileString(lockPath)).toBe(replacement)
      expect(yield* fs.stat(lockPath)).toMatchObject({
        dev: replacementInfo.dev,
        ino: replacementInfo.ino
      })
      expect(yield* lockArtifacts(lockPath)).toEqual([])
    }))

  test.effect("preserves a replacement installed after both strict rereads", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* makeTestDirectory()
      const lockPath = path.join(dir, "backend.lock")
      const original = ownerText(424_242, VALID_TOKEN)
      const replacement = ownerText(100, REPLACEMENT_TOKEN)
      yield* fs.writeFileString(lockPath, original)
      let installed = false
      const result = yield* acquireWithFileSystem(
        dir,
        (fileSystem) => ({
          stat: (target) => fileSystem.stat(target).pipe(
            Effect.tap(() => target.includes(".reclaim.") && !installed
              ? Effect.sync(() => {
                  installed = true
                }).pipe(
                  Effect.andThen(fs.remove(lockPath)),
                  Effect.andThen(fs.writeFileString(lockPath, replacement)),
                  Effect.andThen(fs.chmod(lockPath, 0o600))
                )
              : Effect.void)
          )
        }),
        {},
        processControl(() => Effect.succeed("dead"))
      ).pipe(Effect.result)
      const replacementInfo = yield* fs.stat(lockPath)

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "StateRootLockError",
          reason: "state root ownership changed while the backend was starting"
        }
      })
      expect(yield* fs.readFileString(lockPath)).toBe(replacement)
      expect(yield* fs.stat(lockPath)).toMatchObject({
        dev: replacementInfo.dev,
        ino: replacementInfo.ino
      })
      expect(yield* lockArtifacts(lockPath)).toEqual([])
    }))

  test.effect("treats post-claim canonical disappearance as lost ownership", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* makeTestDirectory()
      const lockPath = path.join(dir, "backend.lock")
      yield* fs.writeFileString(lockPath, ownerText(424_242, VALID_TOKEN))
      const result = yield* acquireStateRootLock(dir, {
        afterClaim: fs.remove(lockPath).pipe(Effect.orDie)
      }).pipe(
        Effect.provideService(ProcessControl, processControl(() => Effect.succeed("dead"))),
        Effect.result
      )

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "StateRootLockError",
          reason: "state root ownership changed while the backend was starting"
        }
      })
      expect(yield* fs.exists(lockPath)).toBe(false)
      expect(yield* lockArtifacts(lockPath)).toEqual([])
    }))

  test.effect("treats a post-claim missing stat as lost ownership", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* makeTestDirectory()
      const lockPath = path.join(dir, "backend.lock")
      const original = ownerText(424_242, VALID_TOKEN)
      const notFound = platformFailure("NotFound", "stat", lockPath)
      yield* fs.writeFileString(lockPath, original)
      const result = yield* acquireWithFileSystem(
        dir,
        (fileSystem) => ({
          stat: (target) => target === lockPath
            ? Effect.fail(notFound)
            : fileSystem.stat(target)
        }),
        {},
        processControl(() => Effect.succeed("dead"))
      ).pipe(Effect.result)

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "StateRootLockError",
          reason: "state root ownership changed while the backend was starting"
        }
      })
      expect(yield* fs.readFileString(lockPath)).toBe(original)
      expect(yield* lockArtifacts(lockPath)).toEqual([])
    }))

  test.effect.each([
    "regular",
    "startup"
  ] as const)("releases the %s scoped wrapper after use success and failure", (variant) =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* makeTestDirectory()
      const successRoot = path.join(dir, "success")
      const successPath = path.join(path.resolve(successRoot), "backend.lock")
      yield* Effect.scoped(
        Effect.gen(function*() {
          const lease = yield* scopedAcquire(variant, successRoot, path)
          expect(yield* fs.exists(lease.path)).toBe(true)
        })
      )
      expect(yield* fs.exists(successPath)).toBe(false)

      const failureRoot = path.join(dir, "failure")
      const failurePath = path.join(path.resolve(failureRoot), "backend.lock")
      const useResult = yield* Effect.scoped(
        Effect.gen(function*() {
          yield* scopedAcquire(variant, failureRoot, path)
          return yield* Effect.fail("use-failure" as const)
        })
      ).pipe(Effect.result)
      expect(useResult).toMatchObject({ _tag: "Failure", failure: "use-failure" })
      expect(yield* fs.exists(failurePath)).toBe(false)
    }))

  test.effect.each([
    "regular",
    "startup"
  ] as const)("releases the %s scoped wrapper after use interruption", (variant) =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* makeTestDirectory()
      const lockPath = path.join(path.resolve(dir), "backend.lock")
      const acquired = yield* Queue.unbounded<void>()
      const fiber = yield* Effect.forkChild(
        Effect.scoped(
          Effect.gen(function*() {
            yield* scopedAcquire(variant, dir, path)
            yield* Queue.offer(acquired, undefined)
            return yield* Effect.never
          })
        )
      )
      yield* awaitSignal(Queue.take(acquired))
      yield* Fiber.interrupt(fiber)

      expect(yield* fs.exists(lockPath)).toBe(false)
      expect(yield* lockArtifacts(lockPath)).toEqual([])
    }))

  test.effect("does not retry or sleep after a non-live-owner failure", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const clock = yield* Clock.Clock
      const dir = yield* makeTestDirectory()
      const lockPath = path.join(path.resolve(dir), "backend.lock")
      const endpointFile = path.join(dir, "server.json")
      const cause = platformFailure("PermissionDenied", "link", lockPath)
      let links = 0
      let sleeps = 0
      const fileSystem = FileSystem.FileSystem.of({
        ...fs,
        link: () => Effect.sync(() => {
          links += 1
        }).pipe(Effect.andThen(Effect.fail(cause)))
      })
      const trackingClock: Clock.Clock = {
        currentTimeMillis: clock.currentTimeMillis,
        currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
        currentTimeNanos: clock.currentTimeNanos,
        currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
        sleep: () => Effect.sync(() => {
          sleeps += 1
        })
      }
      const result = yield* Effect.scoped(stateRootLockForStartup(dir, endpointFile)).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Clock.Clock, trackingClock),
        Effect.result
      )

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "StateRootLockError", cause }
      })
      expect(links).toBe(1)
      expect(sleeps).toBe(0)
    }))

  test.effect("direct release treats post-claim disappearance as lost ownership", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* makeTestDirectory()
      const lease = yield* acquireStateRootLock(dir)
      const result = yield* releaseStateRootLock(lease, {
        afterClaim: fs.remove(lease.path).pipe(Effect.orDie)
      }).pipe(Effect.result)

      expect(result).toMatchObject({ _tag: "Success" })
      expect(yield* fs.exists(lease.path)).toBe(false)
      expect(yield* lockArtifacts(path.join(path.resolve(dir), "backend.lock"))).toEqual([])
    }))

  test.effect.each([
    ["/backend.lock", "/"],
    ["\\backend.lock", "\\"],
    ["C:\\backend.lock", "C:\\"],
    ["C:/backend.lock", "C:/"]
  ] as const)("preserves the filesystem root for release failure at %s", ([lockPath, dataDir]) =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const cause = platformFailure("PermissionDenied", "link", lockPath)
      const error = yield* releaseStateRootLock({
        path: lockPath,
        pid: 100,
        token: VALID_TOKEN
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, FileSystem.FileSystem.of({
          ...fs,
          link: () => Effect.fail(cause)
        })),
        Effect.flip
      )

      expect(error).toMatchObject({ dataDir, cause })
      expect(error.cause).toBe(cause)
    }))

  test.effect("exposes direct release failure and scoped release failure as a defect", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* makeTestDirectory()
      const direct = yield* acquireStateRootLock(path.join(dir, "direct"))
      const directCause = platformFailure("PermissionDenied", "remove", direct.path)
      const directResult = yield* releaseStateRootLock(direct).pipe(
        Effect.provideService(FileSystem.FileSystem, FileSystem.FileSystem.of({
          ...fs,
          remove: (target, options) => target === direct.path
            ? Effect.fail(directCause)
            : fs.remove(target, options)
        })),
        Effect.result
      )
      expect(directResult).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "StateRootLockError", cause: directCause }
      })

      const scopedRoot = path.join(dir, "scoped")
      const scopedPath = path.join(path.resolve(scopedRoot), "backend.lock")
      const scopedCause = platformFailure("PermissionDenied", "remove", scopedPath)
      const scopedExit = yield* Effect.scoped(stateRootLock(scopedRoot)).pipe(
        Effect.provideService(FileSystem.FileSystem, FileSystem.FileSystem.of({
          ...fs,
          remove: (target, options) => target === scopedPath
            ? Effect.fail(scopedCause)
            : fs.remove(target, options)
        })),
        Effect.exit
      )

      expect(Exit.isFailure(scopedExit) && Cause.hasDies(scopedExit.cause)).toBe(true)

      const startupRoot = path.join(dir, "startup")
      const startupPath = path.join(path.resolve(startupRoot), "backend.lock")
      const startupCause = platformFailure("PermissionDenied", "remove", startupPath)
      const startupExit = yield* Effect.scoped(
        stateRootLockForStartup(startupRoot, path.join(startupRoot, "server.json"))
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, FileSystem.FileSystem.of({
          ...fs,
          remove: (target, options) => target === startupPath
            ? Effect.fail(startupCause)
            : fs.remove(target, options)
        })),
        Effect.exit
      )

      expect(Exit.isFailure(startupExit) && Cause.hasDies(startupExit.cause)).toBe(true)
    }))
})

const PositiveSafeInteger = Schema.Int.check(Schema.isGreaterThan(0))
const UuidV4 = Schema.String.check(Schema.isUUID(4))
const LockOwnerSchema = Schema.Struct({ pid: PositiveSafeInteger, token: UuidV4 })
const LockOwnerFromJson = Schema.fromJsonString(LockOwnerSchema)
const ContenderResultSchema = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("acquired"),
    pid: PositiveSafeInteger,
    token: UuidV4
  }),
  Schema.Struct({
    status: Schema.Literal("rejected"),
    reason: Schema.String
  })
])
const ContenderResultFromJson = Schema.fromJsonString(ContenderResultSchema)

type LockOwner = typeof LockOwnerSchema.Type
type ContenderResult = typeof ContenderResultSchema.Type

const strictParseOptions = { onExcessProperty: "error" } as const
const VALID_TOKEN = "00000000-0000-4000-8000-000000000000"
const REPLACEMENT_TOKEN = "11111111-1111-4111-8111-111111111111"

const ownerText = (pid: number, token: string) => `{"pid":${pid},"token":"${token}"}`

const processControl = (
  probe: ProcessControlShape["probe"],
  currentPid = 100
): ProcessControlShape => ({ currentPid, probe })

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

const writeOwner = Effect.fn("StateRootLockTest.writeOwner")(function*(
  path: string,
  owner: LockOwner
) {
  const fs = yield* FileSystem.FileSystem
  const encoded = yield* Schema.encodeEffect(LockOwnerFromJson, strictParseOptions)(owner)
  yield* fs.writeFileString(path, encoded)
})

const readOwner = Effect.fn("StateRootLockTest.readOwner")(function*(path: string) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(path)
  return yield* Schema.decodeUnknownEffect(LockOwnerFromJson, strictParseOptions)(text)
})

const lockArtifacts = Effect.fn("StateRootLockTest.lockArtifacts")(function*(lockPath: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const parent = path.dirname(lockPath)
  const prefix = lockPath.slice(parent.length + 1)
  const entries = yield* fs.readDirectory(parent)
  return entries.filter((entry) => entry.startsWith(`${prefix}.`))
})

const awaitSignal = Effect.fn("StateRootLockTest.awaitSignal")(<A>(effect: Effect.Effect<A>) =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: "2 seconds",
      orElse: () => Effect.fail("signal timed out" as const)
    })
  )
)

const makeTestDirectory = Effect.fn("StateRootLockTest.makeTestDirectory")(function*() {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.makeTempDirectoryScoped({ prefix: "expand-state-root-" })
})

const acquireWithFileSystem = Effect.fn("StateRootLockTest.acquireWithFileSystem")(function*(
  dataDir: string,
  override: (fs: FileSystem.FileSystem) => Partial<FileSystem.FileSystem>,
  options: StateRootLockOptions = {},
  service?: ProcessControlShape
) {
  const fs = yield* FileSystem.FileSystem
  const effect = acquireStateRootLock(dataDir, options).pipe(
    Effect.provideService(FileSystem.FileSystem, FileSystem.FileSystem.of({
      ...fs,
      ...override(fs)
    }))
  )
  return service === undefined
    ? yield* effect
    : yield* effect.pipe(Effect.provideService(ProcessControl, service))
})

const publicationFailure = (
  fs: FileSystem.FileSystem,
  method: "open" | "writeAll" | "sync" | "chmod" | "link",
  cause: PlatformError.PlatformError
): Partial<FileSystem.FileSystem> => {
  if (method === "open") return { open: () => Effect.fail(cause) }
  if (method === "chmod") {
    return {
      chmod: (target, mode) => target.includes(".candidate.")
        ? Effect.fail(cause)
        : fs.chmod(target, mode)
    }
  }
  if (method === "link") return { link: () => Effect.fail(cause) }
  return {
    open: (target, options) => fs.open(target, options).pipe(
      Effect.map((file) => ({
        ...file,
        writeAll: method === "writeAll"
          ? () => Effect.fail(cause)
          : (buffer) => file.writeAll(buffer),
        sync: method === "sync" ? Effect.fail(cause) : file.sync
      }))
    )
  }
}

const scopedAcquire = Effect.fn("StateRootLockTest.scopedAcquire")((
  variant: "regular" | "startup",
  dataDir: string,
  path: Path.Path
) => variant === "regular"
  ? stateRootLock(dataDir)
  : stateRootLockForStartup(dataDir, path.join(dataDir, "server.json")))

const runContenders = Effect.fn("StateRootLockTest.runContenders")(function*(
  stateRoot: string,
  count: number
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const cryptoService = yield* Crypto.Crypto
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const dir = yield* makeTestDirectory()
  const root = path.resolve(".")
  const contenderPath = path.join(root, "apps/server/test/fixtures/state-root-lock-contender.ts")
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
          ["--import", "tsx", contenderPath, stateRoot, readyPath, startPath, releasePath, resultPath],
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
        : Effect.fail(`state-root contender failed with ${String(exitCode)}: ${stderr}`))
    })
  )
})

const waitForAllPaths = Effect.fn("StateRootLockTest.waitForAllPaths")(function*(
  paths: ReadonlyArray<string>
) {
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
