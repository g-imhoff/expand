import { it } from "@effect/vitest"
import { Cause, Crypto, Effect, Exit, Fiber, FileSystem, Layer, Option, Path, PlatformError, Queue, Schedule, Scope } from "effect"
import { describe, expect } from "vitest"
import { NodeServices } from "@effect/platform-node"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import * as Socket from "effect/unstable/socket/Socket"
import { removeEndpointFile, writeEndpointFile } from "@expand/server/endpoint-file"
import { PROTOCOL_VERSION } from "@expand/contracts/endpoint"
import { AppContext, makeAppContext } from "@expand/contracts/app-context"
import { ProcessControl, type ProcessControlShape } from "@expand/contracts/process-control"
import { readEndpoint } from "@expand/client-ts"
import { ProcessServices } from "@expand/client-ts/adapters/node"
import { runServer, type RunServerOptions, ServerComposition } from "@expand/server/composition/app"

const coreLifecycle = {
  nextId: 0,
  releaseDelay: 0,
  releases: [] as Array<number>
}

const observedCoreLayer = Layer.effectDiscard(Effect.acquireRelease(
  Effect.sync(() => ++coreLifecycle.nextId),
  (id) => Effect.sleep(coreLifecycle.releaseDelay).pipe(
    Effect.andThen(Effect.sync(() => coreLifecycle.releases.push(id)))
  )
))

const runObservedServer = (options: RunServerOptions) => runServer(options).pipe(
  Effect.provideService(ServerComposition, { coreLayer: observedCoreLayer })
)

describe("endpoint file (I-3)", () => {
  it.live("writes the file inside the scope and removes it when the scope closes", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "expand-ep-" })
      const appContext = makeTestAppContext(directory, path)
      const file = appContext.paths.endpointFile
      const scope = yield* Scope.make()
      yield* writeEndpointFile({
        url: "ws://127.0.0.1:51789/rpc",
        token: "tok",
        pid: 4242,
        protocolVersion: PROTOCOL_VERSION
      }).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provideService(AppContext, appContext)
      )
      const during = yield* fs.exists(file)
      yield* Scope.close(scope, Exit.void)
      const after = yield* fs.exists(file)
      expect(during).toBe(true)
      expect(after).toBe(false)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.live("ignores only NotFound and preserves permission cleanup with the primary Cause", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "expand-ep-cleanup-" })
      const appContext = makeTestAppContext(directory, path)
      const missing = PlatformError.systemError({
        _tag: "NotFound",
        module: "FileSystem",
        method: "remove",
        pathOrDescriptor: "/missing"
      })
      const permission = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "remove",
        pathOrDescriptor: appContext.paths.endpointFile
      })
      yield* removeEndpointFile(FileSystem.FileSystem.of({
        ...fs,
        remove: () => Effect.fail(missing)
      }), "/missing")
      const scope = yield* Scope.make()
      yield* writeEndpointFile({
        url: "ws://127.0.0.1:51789/rpc",
        token: "tok",
        pid: 4242,
        protocolVersion: PROTOCOL_VERSION
      }).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provideService(AppContext, appContext),
        Effect.provideService(FileSystem.FileSystem, FileSystem.FileSystem.of({
          ...fs,
          remove: () => Effect.fail(permission)
        }))
      )
      const primary = new Error("primary failure")
      const exit = yield* Scope.close(scope, Exit.fail(primary)).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.filter(Cause.isFailReason).map(({ error }) => error)).toContain(primary)
        expect(exit.cause.reasons.filter(Cause.isDieReason).map(({ defect }) => defect)).toContain(permission)
      }
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("constructs the server without reading options, identity, or pid", () =>
    Effect.sync(() => {
      let optionReads = 0
      let randomByteReads = 0
      let pidReads = 0
      const options = {
        get dbPath() {
          optionReads += 1
          return "/tmp/expand-lazy.db"
        },
        get port() {
          optionReads += 1
          return 0
        }
      } satisfies RunServerOptions
      const crypto = Crypto.make({
        randomBytes: (size) => {
          randomByteReads += 1
          return new Uint8Array(size)
        },
        digest: (_algorithm, data) => Effect.succeed(data)
      })
      const processControl: ProcessControlShape = {
        get currentPid() {
          pidReads += 1
          return 4242
        },
        probe: () => Effect.succeed("alive")
      }
      const program = runServer(options).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ProcessControl, processControl)
      )

      expect(Effect.isEffect(program)).toBe(true)
      expect(optionReads).toBe(0)
      expect(randomByteReads).toBe(0)
      expect(pidReads).toBe(0)
    }))

  it.live("releases the HTTP transport and owned core when interrupted while awaiting shutdown", () =>
    Effect.gen(function*() {
      resetCoreLifecycle()
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "expand-ep-interrupt-" })
      const appContext = makeTestAppContext(directory, path)
      const endpointUp = readEndpoint.pipe(
        Effect.flatMap((endpoint) => Option.isSome(endpoint) ? Effect.succeed(endpoint.value) : Effect.fail("pending" as const)),
        Effect.retry(Schedule.spaced("25 millis")),
        Effect.timeout("5 seconds")
      )
      const server = yield* runObservedServer({ dbPath: path.join(directory, "interrupt.db") }).pipe(
        Effect.provideService(AppContext, appContext),
        Effect.forkChild
      )
      const endpoint = yield* endpointUp.pipe(Effect.provideService(AppContext, appContext))
      const port = Number(new URL(endpoint.url).port)
      yield* Fiber.interrupt(server)
      expect(coreLifecycle.releases).toEqual([1])
      expect(yield* bindThenFail(port, path.join(directory, "interrupt-rebind.db"), appContext, fs)).toBe(true)
    }).pipe(Effect.provide(TestServices)))

  it.live("bounds abnormal transport close with an active authenticated connection and releases the owned core", () =>
    Effect.gen(function*() {
      resetCoreLifecycle()
      const path = yield* Path.Path
      const directory = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix: "expand-ep-active-interrupt-" }))
      )
      const appContext = makeTestAppContext(directory, path)
      const endpointUp = readEndpoint.pipe(
        Effect.flatMap((endpoint) => Option.isSome(endpoint) ? Effect.succeed(endpoint.value) : Effect.fail("pending" as const)),
        Effect.retry(Schedule.spaced("25 millis")),
        Effect.timeout("5 seconds")
      )
      const server = yield* runObservedServer({ dbPath: path.join(directory, "active-interrupt.db") }).pipe(
        Effect.provideService(AppContext, appContext),
        Effect.forkChild
      )
      const endpoint = yield* endpointUp.pipe(Effect.provideService(AppContext, appContext))
      const opened = yield* Queue.unbounded<void>()
      const socket = yield* Socket.makeWebSocket(`${endpoint.url}?token=${encodeURIComponent(endpoint.token)}`).pipe(
        Effect.provide(NodeSocket.layerWebSocketConstructorWS)
      )
      const socketFiber = yield* socket.runRaw(() => undefined, { onOpen: Queue.offer(opened, undefined) }).pipe(
        Effect.forkChild
      )
      yield* Queue.take(opened).pipe(Effect.timeout("5 seconds"))
      const interruption = yield* Fiber.interrupt(server).pipe(Effect.forkChild)
      const completed = yield* Fiber.join(interruption).pipe(
        Effect.as(true),
        Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.succeed(false) })
      )
      yield* Fiber.interrupt(socketFiber)
      expect(completed).toBe(true)
      expect(coreLifecycle.releases).toEqual([1])
    }).pipe(Effect.provide(TestServices)), 10_000)

  it.live("preserves the startup failure Cause and releases the HTTP transport and owned core", () =>
    Effect.gen(function*() {
      resetCoreLifecycle()
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "expand-ep-failure-" })
      const appContext = makeTestAppContext(directory, path)
      const port = 51987
      const denied = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "chmod",
        pathOrDescriptor: directory
      })
      const failingFs = FileSystem.FileSystem.of({
        ...fs,
        chmod: () => Effect.fail(denied)
      })
      const exit = yield* runObservedServer({ dbPath: path.join(directory, "failure.db"), port }).pipe(
        Effect.provideService(AppContext, appContext),
        Effect.provideService(FileSystem.FileSystem, failingFs),
        Effect.exit
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.some((reason) => Cause.isFailReason(reason) && reason.error === denied)).toBe(true)
      }
      expect(coreLifecycle.releases).toEqual([1])
      expect(yield* bindThenFail(port, path.join(directory, "failure-rebind.db"), appContext, fs)).toBe(true)
    }).pipe(Effect.provide(TestServices)))

  it.live("does not abandon a delayed abnormal child finalizer at the normal shutdown deadline", () =>
    Effect.gen(function*() {
      resetCoreLifecycle()
      coreLifecycle.releaseDelay = 1_100
      const path = yield* Path.Path
      const directory = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix: "expand-ep-delayed-release-" }))
      )
      const appContext = makeTestAppContext(directory, path)
      const endpointUp = readEndpoint.pipe(
        Effect.flatMap((endpoint) => Option.isSome(endpoint) ? Effect.succeed(endpoint.value) : Effect.fail("pending" as const)),
        Effect.retry(Schedule.spaced("25 millis")),
        Effect.timeout("5 seconds")
      )
      const server = yield* runObservedServer({ dbPath: path.join(directory, "delayed.db") }).pipe(
        Effect.provideService(AppContext, appContext),
        Effect.forkChild
      )
      yield* endpointUp.pipe(Effect.provideService(AppContext, appContext))
      yield* Fiber.interrupt(server)
      expect(coreLifecycle.releases).toEqual([1])
    }).pipe(Effect.provide(TestServices)), 10_000)

  it.live("advertises the injected identity and pid", () => {
    let randomByteReads = 0
    let pidReads = 0
    const crypto = Crypto.make({
      randomBytes: (size) => {
        randomByteReads += 1
        return Uint8Array.from({ length: size }, (_, index) => index)
      },
      digest: (_algorithm, data) => Effect.succeed(data)
    })
    const processControl: ProcessControlShape = {
      get currentPid() {
        pidReads += 1
        return 4242
      },
      probe: () => Effect.succeed("alive")
    }

    return Effect.gen(function*() {
      resetCoreLifecycle()
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "expand-ep-injected-" })
      const appContext = makeTestAppContext(directory, path)
      const endpointUp = readEndpoint.pipe(
        Effect.flatMap((endpoint) => Option.isSome(endpoint) ? Effect.succeed(endpoint.value) : Effect.fail("pending" as const)),
        Effect.retry(Schedule.spaced("25 millis")),
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () => Effect.fail("server never advertised an endpoint" as const)
        })
      )
      const program = Effect.gen(function*() {
        const server = yield* Effect.forkChild(runServer({ dbPath: path.join(directory, "injected.db") }))
        const endpoint = yield* endpointUp
        yield* Fiber.interrupt(server)
        expect(endpoint.token).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f")
        expect(endpoint.pid).toBe(4242)
        expect(randomByteReads).toBe(1)
        expect(pidReads).toBe(1)
      })

      yield* program.pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ProcessControl, processControl),
        Effect.provideService(AppContext, appContext)
      )
    }).pipe(Effect.provide(NodeServices.layer))
  })
})

const TestServices = Layer.mergeAll(ProcessServices.layer, NodeServices.layer)

const resetCoreLifecycle = () => {
  coreLifecycle.nextId = 0
  coreLifecycle.releaseDelay = 0
  coreLifecycle.releases = []
}

const bindThenFail = Effect.fn("EndpointFileTest.bindThenFail")(function*(
  port: number,
  dbPath: string,
  appContext: ReturnType<typeof makeTestAppContext>,
  fs: FileSystem.FileSystem
) {
  const denied = PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method: "chmod",
    pathOrDescriptor: dbPath
  })
  const exit = yield* runServer({ dbPath, port }).pipe(
    Effect.provideService(AppContext, appContext),
    Effect.provideService(FileSystem.FileSystem, FileSystem.FileSystem.of({
      ...fs,
      chmod: () => Effect.fail(denied)
    })),
    Effect.exit
  )
  return Exit.isFailure(exit) && exit.cause.reasons.some(
    (reason) => Cause.isFailReason(reason) && reason.error === denied
  )
})

const makeTestAppContext = (dataDir: string, path: Path.Path) =>
  makeAppContext(
    { join: path.join, resolve: path.resolve },
    { homeDir: dataDir, cwd: dataDir, dataDir }
  )
