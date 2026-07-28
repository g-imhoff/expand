import { it } from "@effect/vitest"
import { Cause, Crypto, Effect, Exit, Fiber, FileSystem, Option, Path, PlatformError, Schedule, Scope } from "effect"
import { describe, expect } from "vitest"
import { NodeServices } from "@effect/platform-node"
import { removeEndpointFile, writeEndpointFile } from "@expand/server/endpoint-file"
import { PROTOCOL_VERSION } from "@expand/contracts/endpoint"
import { AppContext, makeAppContext } from "@expand/contracts/app-context"
import { ProcessControl, type ProcessControlShape } from "@expand/contracts/process-control"
import { readEndpoint } from "@expand/client-ts"
import { runServer, type RunServerOptions } from "@expand/server/composition/app"

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

const makeTestAppContext = (dataDir: string, path: Path.Path) =>
  makeAppContext(
    { join: path.join, resolve: path.resolve },
    { homeDir: dataDir, cwd: dataDir, dataDir }
  )
