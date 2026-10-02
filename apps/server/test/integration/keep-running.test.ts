import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { NodeServices } from "@effect/platform-node"
import { BackendUnavailable, readEndpoint, withClient } from "@expand/client-ts"
import type { ExpandRpcClientApi } from "@expand/client-ts"
import { makeNodeAdapter } from "@expand/client-ts/adapters/node"
import { AppContext, makeAppContext, type AppContextShape } from "@expand/contracts/app-context"
import { ConnectionTracker } from "@expand/server/runtime/connection-tracker"
import { runServer, ServerComposition, type RunServerOptions } from "@expand/server/composition/app"
import { ProcessServices } from "@expand/server/runtime/node-process-control"
import { ChildProcess } from "effect/process"
import { createConnection } from "node:net"
import {
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
  Path,
  PlatformError,
  Queue,
  Schedule,
  Stream
} from "effect"
import type { RuntimeAdapter } from "@expand/client-ts"

const observedTrackerLayer = (disconnects: Queue.Queue<void>) =>
  Layer.effect(ConnectionTracker, Effect.map(ConnectionTracker.make, (tracker) => ({
    ...tracker,
    onDisconnect: tracker.onDisconnect.pipe(
      Effect.andThen(Queue.offer(disconnects, undefined)),
      Effect.asVoid
    )
  })))

const coreLifecycle = {
  nextId: 0,
  releases: [] as Array<number>
}

const observedCoreLayer = Layer.effectDiscard(Effect.acquireRelease(
  Effect.sync(() => ++coreLifecycle.nextId),
  (id) => Effect.sync(() => coreLifecycle.releases.push(id))
))

const noSpawnAdapter: RuntimeAdapter = (() => {
  const adapter = makeNodeAdapter({
    backendCommand: Effect.succeed(["node", "--import", "tsx", "apps/server/main.ts"])
  })
  return {
    ...adapter,
    spawnBackend: () => Effect.fail(new BackendUnavailable({ reason: "backend replacement is forbidden" }))
  }
})()

const awaitLiveEndpoint = Effect.fn("KeepRunning.awaitLiveEndpoint")(function*() {
  return yield* readEndpoint.pipe(
    Effect.flatMap((endpoint) => Option.isSome(endpoint) ? Effect.succeed(endpoint.value) : Effect.fail("endpoint pending" as const)),
    Effect.retry(Schedule.spaced("25 millis")),
    Effect.timeout("10 seconds")
  )
})

const runClient = <A, E, R>(
  context: AppContextShape,
  use: (client: ExpandRpcClientApi) => Effect.Effect<A, E, R>
) => withClient(noSpawnAdapter, use).pipe(
  Effect.provideService(AppContext, context),
  Effect.provide(ProcessServices.layer)
)

const probeTcp = (port: number) =>
  Effect.callback<"open" | "closed">((resume) => {
    const socket = createConnection({ host: "127.0.0.1", port })
    const close = () => socket.destroy()
    socket.once("connect", () => {
      close()
      resume(Effect.succeed("open" as const))
    })
    socket.once("error", () => {
      close()
      resume(Effect.succeed("closed" as const))
    })
    socket.setTimeout(1_000, () => {
      close()
      resume(Effect.succeed("closed" as const))
    })
    return Effect.sync(close)
  })

const awaitTcpClosed = Effect.fn("KeepRunning.awaitTcpClosed")(function*(port: number) {
  return yield* probeTcp(port).pipe(
    Effect.filterOrFail((state) => state === "closed", () => "listener open" as const),
    Effect.retry(Schedule.spaced("25 millis")),
    Effect.timeout("5 seconds")
  )
})

const awaitPathAbsent = Effect.fn("KeepRunning.awaitPathAbsent")(function*(
  fs: FileSystem.FileSystem,
  file: string
) {
  return yield* fs.exists(file).pipe(
    Effect.flatMap((exists) => exists ? Effect.fail("present" as const) : Effect.void),
    Effect.retry(Schedule.spaced("25 millis")),
    Effect.timeout("5 seconds")
  )
})

const childOutput = (
  stdout: Fiber.Fiber<string, PlatformError.PlatformError>,
  stderr: Fiber.Fiber<string, PlatformError.PlatformError>
) => Effect.all([Fiber.join(stdout), Fiber.join(stderr)], { concurrency: "unbounded" })

const startProductionChild = Effect.fn("KeepRunning.startProductionChild")(function*(
  dataDir: string,
  args: ReadonlyArray<string>,
  cwd?: string
) {
  const path = yield* Path.Path
  const child = yield* ChildProcess.make(
    "node",
    ["--import", import.meta.resolve("tsx"), path.resolve("apps/server/main.ts"), ...args, "--data-dir", dataDir],
    {
      cwd: cwd ?? path.resolve("."),
      env: { HOME: cwd ?? dataDir, EXPAND_LOG_LEVEL: "None", TSX_TSCONFIG_PATH: path.resolve("tsconfig.json") },
      extendEnv: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe"
    }
  )
  const stdout = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString, Effect.forkScoped)
  const stderr = yield* child.stderr.pipe(Stream.decodeText(), Stream.mkString, Effect.forkScoped)
  return { child, stdout, stderr }
})

type ServerChild = Effect.Success<ReturnType<typeof startProductionChild>>

const unexpectedChildExit = (
  server: ServerChild,
  label: string,
  code: Effect.Success<ServerChild["child"]["exitCode"]>
) => childOutput(server.stdout, server.stderr).pipe(
  Effect.flatMap(([stdout, stderr]) => Effect.fail(
    `${label} exited with code ${String(code)}: stdout=${stdout} stderr=${stderr}`
  ))
)

const awaitChildEndpoint = Effect.fn("KeepRunning.awaitChildEndpoint")(function*(
  context: AppContextShape,
  server: ServerChild,
  label: string
) {
  return yield* Effect.raceFirst(
    awaitLiveEndpoint().pipe(
      Effect.provideService(AppContext, context),
      Effect.provide(ProcessServices.layer)
    ),
    server.child.exitCode.pipe(Effect.flatMap((code) => unexpectedChildExit(server, label, code)))
  )
})

const assertChildAlive = Effect.fn("KeepRunning.assertChildAlive")(function*(
  server: ServerChild,
  label: string
) {
  const exit = yield* server.child.exitCode.pipe(Effect.timeoutOption("25 millis"))
  if (Option.isSome(exit)) {
    return yield* unexpectedChildExit(server, label, exit.value)
  }
})

const resetCoreLifecycle = () => {
  coreLifecycle.nextId = 0
  coreLifecycle.releases = []
}

const runSignalCase = (
  signal: "SIGINT" | "SIGTERM",
  keepRunning: boolean,
  activeClient: boolean
) => Effect.scoped(Effect.gen(function*() {
  const path = yield* Path.Path
  const fs = yield* FileSystem.FileSystem
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "expand-keep-running-signal-" })
  const context = makeAppContext(path, { homeDir: dir, cwd: dir, dataDir: dir })
  const args = keepRunning ? ["--keep-running"] : []
  const server = yield* startProductionChild(dir, args)
  const endpoint = yield* awaitChildEndpoint(context, server, `${signal} server`)
  const endpointFile = context.paths.endpointFile
  const lockFile = path.join(dir, "backend.lock")
  const dbPath = path.join(dir, "events.db")
  const port = Number(new URL(endpoint.url).port)

  expect(Number(endpoint.pid)).toBe(Number(server.child.pid))
  if (keepRunning) {
    for (let index = 0; index < 3; index += 1) {
      const result = yield* runClient(context, (client) => Effect.gen(function*() {
        const health = yield* client.Health()
        const created = index === 0
          ? yield* client.ProjectCreate({ name: "signal-state", ensure: false })
          : undefined
        const listed = yield* client.ProjectList({})
        return { health, created, listed }
      })).pipe(Effect.timeout("5 seconds"))
      yield* assertChildAlive(server, `${signal} keep-running server`)
      const current = yield* awaitLiveEndpoint().pipe(
        Effect.provideService(AppContext, context),
        Effect.provide(ProcessServices.layer)
      )
      expect(current).toEqual(endpoint)
      expect(result.health).toBe("ok")
      expect(result.listed.projects.length).toBe(1)
      if (index === 0) expect(result.created?.project.name).toBe("signal-state")
    }
  }

  let activeFiber: Fiber.Fiber<unknown, unknown> | undefined
  if (activeClient) {
    const connected = yield* Deferred.make<void>()
    activeFiber = yield* runClient(context, (client) => Effect.gen(function*() {
      yield* client.Health()
      yield* Deferred.succeed(connected, undefined)
      return yield* Effect.never
    })).pipe(
      Effect.provide(Logger.layer([Logger.make(() => undefined)])),
      Effect.forkChild
    )
    yield* Deferred.await(connected).pipe(Effect.timeout("5 seconds"))
  }

  yield* server.child.kill({ killSignal: signal })
  if (activeFiber !== undefined) yield* Fiber.interrupt(activeFiber)
  const exitCode = yield* server.child.exitCode.pipe(Effect.timeout("5 seconds"))
  expect(Number(exitCode)).toBe(0)
  yield* awaitPathAbsent(fs, endpointFile)
  yield* awaitPathAbsent(fs, lockFile)
  expect(yield* awaitTcpClosed(port)).toBe("closed")
  expect(yield* fs.exists(dbPath)).toBe(true)

  const replacement = yield* startProductionChild(dir, args)
  const replacementEndpoint = yield* awaitChildEndpoint(context, replacement, `${signal} replacement`)
  expect(Number(replacementEndpoint.pid)).toBe(Number(replacement.child.pid))
  const replacementResult = yield* runClient(context, (client) => Effect.gen(function*() {
    const health = yield* client.Health()
    const listed = yield* client.ProjectList({})
    return { health, listed }
  })).pipe(Effect.timeout("5 seconds"))
  expect(replacementResult.health).toBe("ok")
  if (keepRunning) expect(replacementResult.listed.projects.map(({ name }) => name)).toContain("signal-state")
  if (keepRunning) yield* replacement.child.kill({ killSignal: "SIGTERM" })
  const replacementExitCode = yield* replacement.child.exitCode.pipe(Effect.timeout("5 seconds"))
  expect(Number(replacementExitCode)).toBe(0)
  yield* awaitPathAbsent(fs, endpointFile)
  yield* awaitPathAbsent(fs, lockFile)
}))

describe("keep-running lifecycle", { concurrent: false }, () => {
  it.live("keeps the same server through three completed disconnects and reconnects", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path.pipe(Effect.provide(NodeServices.layer))
      const fs = yield* FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer))
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "expand-keep-running-" })
      const context = makeAppContext(path, { homeDir: dir, cwd: dir, dataDir: dir })
      const disconnects = yield* Queue.unbounded<void>()
      const options: RunServerOptions = { dbPath: path.join(dir, "events.db"), keepRunning: true }
      const serverFiber = yield* runServer(options).pipe(
        Effect.provideService(ServerComposition, { coreLayer: observedTrackerLayer(disconnects) }),
        Effect.provideService(AppContext, context),
        Effect.provide(ProcessServices.layer),
        Effect.forkChild
      )

      const endpoint = yield* awaitLiveEndpoint().pipe(
        Effect.provideService(AppContext, context),
        Effect.provide(ProcessServices.layer),
        Effect.raceFirst(Fiber.join(serverFiber))
      )
      const before = endpoint
      for (let index = 0; index < 3; index += 1) {
        const result = yield* runClient(context, (client) => Effect.gen(function*() {
          const health = yield* client.Health()
          const created = index === 0
            ? yield* client.ProjectCreate({ name: "keep-running", ensure: false })
            : undefined
          const listed = yield* client.ProjectList({})
          return { health, created, listed }
        })).pipe(Effect.timeout("5 seconds"))
        yield* Queue.take(disconnects).pipe(Effect.timeout("5 seconds"))
        const endpointAfterDisconnect = yield* fs.exists(context.paths.endpointFile)
        const after = endpointAfterDisconnect
          ? yield* awaitLiveEndpoint().pipe(
              Effect.provideService(AppContext, context),
              Effect.provide(ProcessServices.layer)
            )
          : undefined
        const stopped = yield* Fiber.join(serverFiber).pipe(Effect.timeoutOption("250 millis"))

        expect(result.health).toBe("ok")
        expect(result.listed.projects.length).toBe(1)
        if (index === 0) expect(result.created?.project.name).toBe("keep-running")
        expect(endpointAfterDisconnect).toBe(true)
        expect(after).toEqual(before)
        expect(Option.isNone(stopped)).toBe(true)
      }

      const finalEndpoint = yield* awaitLiveEndpoint().pipe(
        Effect.provideService(AppContext, context),
        Effect.provide(ProcessServices.layer)
      )
      yield* Fiber.interrupt(serverFiber)

      expect(finalEndpoint).toEqual(before)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.live("releases the endpoint, listener, and injected core in both modes on interruption", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path.pipe(Effect.provide(NodeServices.layer))
      const fs = yield* FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer))

      for (const keepRunning of [false, true]) {
        resetCoreLifecycle()
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "expand-keep-running-interrupt-" })
        const context = makeAppContext(path, { homeDir: dir, cwd: dir, dataDir: dir })
        const dbPath = path.join(dir, "events.db")
        const serverFiber = yield* runServer({ dbPath, keepRunning }).pipe(
          Effect.provideService(ServerComposition, { coreLayer: observedCoreLayer }),
          Effect.provideService(AppContext, context),
          Effect.provide(ProcessServices.layer),
          Effect.forkChild
        )
        const endpoint = yield* awaitLiveEndpoint().pipe(
          Effect.provideService(AppContext, context),
          Effect.provide(ProcessServices.layer)
        )
        const port = Number(new URL(endpoint.url).port)

        yield* Fiber.interrupt(serverFiber)
        expect(coreLifecycle.releases).toEqual([1])
        expect(yield* fs.exists(context.paths.endpointFile)).toBe(false)
        expect(yield* fs.exists(dbPath)).toBe(true)

        const replacementFiber = yield* runServer({ dbPath, port, keepRunning }).pipe(
          Effect.provideService(ServerComposition, { coreLayer: observedCoreLayer }),
          Effect.provideService(AppContext, context),
          Effect.provide(ProcessServices.layer),
          Effect.forkChild
        )
        const replacementEndpoint = yield* awaitLiveEndpoint().pipe(
          Effect.provideService(AppContext, context),
          Effect.provide(ProcessServices.layer)
        )
        yield* Fiber.interrupt(replacementFiber)
        expect(Number(new URL(replacementEndpoint.url).port)).toBe(port)
        expect(coreLifecycle.releases).toEqual([1, 2])
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.live("prints backend help without acquiring startup resources", () =>
    Effect.scoped(Effect.gen(function*() {
      const path = yield* Path.Path
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "expand-keep-running-help-" })
      const child = yield* startProductionChild(dir, ["--help"])
      const exitCode = yield* child.child.exitCode
      const [stdout, stderr] = yield* childOutput(child.stdout, child.stderr)

      expect(Number(exitCode)).toBe(0)
      expect(stdout).toContain("--keep-running")
      expect(stdout).toContain("last client disconnects")
      expect(stdout).toContain("--data-dir DIR")
      expect(stderr).toBe("")
      expect(yield* fs.exists(path.join(dir, "backend.lock"))).toBe(false)
      expect(yield* fs.exists(path.join(dir, "server.json"))).toBe(false)
      expect(yield* fs.exists(path.join(dir, "events.db"))).toBe(false)
    }).pipe(Effect.provide(NodeServices.layer))))

  for (const dataDir of ["--keep-running", "--help"]) {
    it.live(`uses ${dataDir} as the data directory and stops after the last client disconnects`, () =>
      Effect.scoped(Effect.gen(function*() {
        const path = yield* Path.Path
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "expand-keep-running-data-dir-" })
        const context = makeAppContext(path, { homeDir: dir, cwd: dir, dataDir })
        const server = yield* startProductionChild(dataDir, [], dir)
        const endpoint = yield* awaitChildEndpoint(context, server, `${dataDir} directory server`)
        const port = Number(new URL(endpoint.url).port)

        expect(Number(endpoint.pid)).toBe(Number(server.child.pid))
        expect(yield* runClient(context, (client) => client.Health())).toBe("ok")
        const exitCode = yield* server.child.exitCode.pipe(Effect.timeout("5 seconds"))

        expect(Number(exitCode)).toBe(0)
        yield* awaitPathAbsent(fs, context.paths.endpointFile)
        yield* awaitPathAbsent(fs, path.join(context.paths.dataDir, "backend.lock"))
        expect(yield* awaitTcpClosed(port)).toBe("closed")
        expect(yield* fs.exists(context.paths.dbPath)).toBe(true)
      })).pipe(Effect.provide(NodeServices.layer)))
  }

  it.live("stops and reopens the default backend on SIGINT", () =>
    runSignalCase("SIGINT", false, false).pipe(Effect.provide(NodeServices.layer)),
    30_000
  )

  it.live("stops and reopens the default backend on SIGTERM", () =>
    runSignalCase("SIGTERM", false, false).pipe(Effect.provide(NodeServices.layer)),
    30_000
  )

  it.live("stops and reopens an idle keep-running backend on SIGINT", () =>
    runSignalCase("SIGINT", true, false).pipe(Effect.provide(NodeServices.layer)),
    30_000
  )

  it.live("stops a keep-running backend with an active client on SIGTERM", () =>
    runSignalCase("SIGTERM", true, true).pipe(Effect.provide(NodeServices.layer)),
    30_000
  )
})
