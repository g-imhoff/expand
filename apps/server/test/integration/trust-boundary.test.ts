import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, Exit, Queue, Fiber, FileSystem, Layer, Option, Path, PlatformError, Schedule, Schema, Stream } from "effect"
import { HttpServer } from "effect/unstable/http"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { readEndpoint, withClient } from "@expand/client-ts"
import { runServer } from "@expand/server/composition/app"
import { writeEndpointFile } from "@expand/server/endpoint-file"
import { PROTOCOL_VERSION } from "@expand/contracts/endpoint"
import { AppContext, makeAppContext } from "@expand/contracts/app-context"
import { ProcessControl } from "@expand/contracts/process-control"

import { httpServerLayer } from "@expand/server/http"
import { ReplayFeedLayer } from "@expand/server/db/replay-feed"
import { EventBusLayer } from "@expand/server/application/event-bus"
import { ProjectProjectionLayer } from "@expand/server/application/projections"
import { ProjectEventStoreLayer } from "@expand/server/application/projects/project-event-store"
import { ProjectionStateStoreLayer } from "@expand/server/db/projection-state-store"
import { ProjectUseCasesLayer } from "@expand/server/application/projects/use-cases"
import { ServerUseCasesLayer } from "@expand/server/application/server/use-cases"
import { ConnectionTrackerLayer } from "@expand/server/connection-tracker"
import { NodeFileSystem, NodeServices } from "@effect/platform-node"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import { ChildProcess } from "effect/unstable/process"
import * as Socket from "effect/unstable/socket/Socket"
import { ProcessServices } from "@expand/server/node-process-control"
import { makeNodeAdapter } from "@expand/client-ts/adapters/node"

const nodeAdapter = makeNodeAdapter({
  backendCommand: Effect.succeed(["node", "--import", "tsx", "apps/server/main.ts"])
})


const awaitEndpointUp = readEndpoint.pipe(
  Effect.flatMap((o) => (Option.isSome(o) ? Effect.void : Effect.fail("pending" as const))),
  Effect.retry(Schedule.spaced("25 millis")),
  Effect.timeoutOrElse({
    duration: "5 seconds",
    orElse: () => Effect.fail("server never advertised an endpoint (I-3)")
  })
)

const currentEndpoint = readEndpoint.pipe(
  Effect.flatMap((o) =>
    Option.isSome(o) ? Effect.succeed(o.value) : Effect.fail("endpoint file missing")
  )
)

// mirrors coreLayer in composition/app.ts (not exported)
const testCore = (dbPath: string) => {
  const sql = SqliteClient.layer({ filename: dbPath })
  const replay = ReplayFeedLayer.pipe(Layer.provide(sql))
  const projectEvents = ProjectEventStoreLayer.pipe(Layer.provide(sql))
  const states = ProjectionStateStoreLayer.pipe(Layer.provide(sql))
  const projection = ProjectProjectionLayer.pipe(Layer.provide(projectEvents), Layer.provide(states))
  const projectUseCases = ProjectUseCasesLayer.pipe(
    Layer.provide(projectEvents),
    Layer.provide(EventBusLayer),
    Layer.provide(projection),
    Layer.provide(NodeFileSystem.layer),
    Layer.provide(ProcessServices.layer)
  )
  return Layer.mergeAll(projectUseCases, ServerUseCasesLayer, EventBusLayer, ConnectionTrackerLayer, projection, replay)
}

const probeTcp = (host: string, port: number) =>
  Effect.scoped(Effect.gen(function*() {
    const opened = yield* Queue.unbounded<void>()
    const socket = yield* NodeSocket.makeNet({ host, port, openTimeout: "2 seconds" })
    const run = yield* socket.runRaw(() => undefined, { onOpen: Queue.offer(opened, undefined) }).pipe(
      Effect.forkScoped
    )
    return yield* Effect.race(
      Queue.take(opened).pipe(Effect.as("open" as const)),
      Fiber.join(run).pipe(Effect.as("closed" as const), Effect.catchCause(() => Effect.succeed("closed" as const)))
    ).pipe(Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.succeed("closed" as const) }))
  }))

const OffLoopbackTargets = Schema.fromJsonString(Schema.Array(Schema.String))

const startChild = (args: ReadonlyArray<string>) => Effect.gen(function*() {
  const child = yield* ChildProcess.make(
    "node",
    args,
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" }
  )
  const stdout = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString, Effect.forkScoped)
  const stderr = yield* child.stderr.pipe(Stream.decodeText(), Stream.mkString, Effect.forkScoped)
  return { child, stdout, stderr }
})

const startTrustBoundaryHost = (args: ReadonlyArray<string>) =>
  startChild(["--import", "tsx", "apps/server/test/fixtures/trust-boundary-host.ts", ...args])

type TrustBoundaryHost = Effect.Success<ReturnType<typeof startTrustBoundaryHost>>
type ChildExitCode = Effect.Success<TrustBoundaryHost["child"]["exitCode"]>

const childOutput = (
  stdout: Fiber.Fiber<string, PlatformError.PlatformError>,
  stderr: Fiber.Fiber<string, PlatformError.PlatformError>
) =>
  Effect.all([Fiber.join(stdout), Fiber.join(stderr)], { concurrency: "unbounded" })

const offLoopbackTargets = Effect.scoped(Effect.gen(function*() {
  const { child, stdout, stderr } = yield* startTrustBoundaryHost(["network-targets"])
  const code = yield* child.exitCode
  const [output, error] = yield* childOutput(stdout, stderr)
  if (Number(code) !== 0) {
    return yield* Effect.fail(`network target fixture exited with nonzero code ${String(code)}: stdout=${output} stderr=${error}`)
  }
  return yield* Schema.decodeUnknownEffect(OffLoopbackTargets)(output)
}))

const unexpectedChildExit = (host: TrustBoundaryHost, label: string, code: ChildExitCode) =>
  childOutput(host.stdout, host.stderr).pipe(
    Effect.flatMap(([output, error]) => Effect.fail(
      Number(code) === 0
        ? `${label} exited unexpectedly with code 0: stdout=${output} stderr=${error}`
        : `${label} exited with nonzero code ${String(code)}: stdout=${output} stderr=${error}`
    ))
  )

const awaitChildReadiness = Effect.fn("TrustBoundary.awaitChildReadiness")(function*(
  readiness: Effect.Effect<void, unknown, FileSystem.FileSystem | AppContext | ProcessControl>,
  host: TrustBoundaryHost,
  label: string
) {
  yield* Effect.raceFirst(
    readiness,
    host.child.exitCode.pipe(Effect.flatMap((code) => unexpectedChildExit(host, label, code)))
  )
})

const assertChildAlive = Effect.fn("TrustBoundary.assertChildAlive")(function*(
  host: TrustBoundaryHost,
  label: string
) {
  const exit = yield* host.child.exitCode.pipe(Effect.timeoutOption("1 millis"))
  if (Option.isSome(exit)) return yield* unexpectedChildExit(host, label, exit.value)
})

const probeWs = (url: string) =>
  Effect.scoped(Effect.gen(function*() {
    const opened = yield* Queue.unbounded<void>()
    const socket = yield* Socket.makeWebSocket(url, { openTimeout: "2 seconds" }).pipe(
      Effect.provide(NodeSocket.layerWebSocketConstructorWS)
    )
    const run = yield* socket.runRaw(() => undefined, { onOpen: Queue.offer(opened, undefined) }).pipe(
      Effect.forkScoped
    )
    return yield* Effect.race(
      Queue.take(opened).pipe(Effect.as("open" as const)),
      Fiber.join(run).pipe(Effect.as("closed" as const), Effect.catchCause(() => Effect.succeed("closed" as const)))
    ).pipe(Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.succeed("closed" as const) }))
  }))

describe.sequential("trust boundary", () => {
  it.live("surfaces an early failing child before readiness times out", () => Effect.gen(function*() {
    const path = yield* Path.Path
    const dir = yield* makeTestDirectory("expand-trust-boundary-early-exit-")
    const host = yield* startChild(["--definitely-invalid-expand-option"])
    const error = yield* awaitChildReadiness(awaitEndpointUp, host, "trust boundary fixture").pipe(
      Effect.timeoutOrElse({
        duration: "1 second",
        orElse: () => Effect.fail("early exit was not surfaced" as const)
      }),
      Effect.flip,
      Effect.provide(ProcessServices.layer),
      Effect.provide(Layer.succeed(AppContext, makeTestAppContext(path, dir)))
    )
    expect(error).toBe(
      "trust boundary fixture exited with nonzero code 9: stdout= stderr=node: bad option: --definitely-invalid-expand-option\n"
    )
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.live("binds to a 127.0.0.1 TcpAddress",  () => Effect.gen(function*() {
    const path = yield* Path.Path.pipe(Effect.provide(NodeServices.layer))
    const dir = yield* makeTestDirectory('expand-trust-boundary-')
    const program = Effect.gen(function* () {
      const transport = yield* Layer.build(
        Layer.mergeAll(
          httpServerLayer(0, "trust-boundary-token").pipe(Layer.provide(testCore(path.join(dir, "bind.db")))),
          ProcessServices.layer
        )
      )
      const server = yield* HttpServer.HttpServer.pipe(Effect.provide(transport))
      const addr = server.address
      return addr._tag === "TcpAddress" ? addr.hostname : `unexpected:${addr._tag}`
    }).pipe(Effect.scoped, Effect.provide(ProcessServices.layer), Effect.provide(Layer.succeed(AppContext, makeTestAppContext(path, dir))))

    const hostname = yield* (program)
    expect(hostname).toBe("127.0.0.1")
  }))

  it.live("advertises 127.0.0.1 and is unreachable off IPv4 loopback",  () => Effect.gen(function*() {
    const path = yield* Path.Path.pipe(Effect.provide(NodeServices.layer))
    const dir = yield* makeTestDirectory('expand-trust-boundary-')
    const program = Effect.gen(function* () {
      const dbPath = path.join(dir, "events.db")
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
      yield* awaitEndpointUp
      const endpoint = yield* currentEndpoint
      const advertisedHost = new URL(endpoint.url).hostname
      const port = Number(new URL(endpoint.url).port)
      const loopback = yield* probeTcp("127.0.0.1", port)
      const offLoopback = yield* Effect.forEach(
        yield* offLoopbackTargets,
        (host) => Effect.map(probeTcp(host, port), (result) => ({ host, result })),
        { concurrency: "unbounded" }
      )
      yield* Fiber.interrupt(serverFiber)
      return { advertisedHost, loopback, offLoopback }
    }).pipe(Effect.scoped, Effect.provide(ProcessServices.layer), Effect.provide(Layer.succeed(AppContext, makeTestAppContext(path, dir))))

    const r = yield* (program)
    expect(r.advertisedHost).toBe("127.0.0.1")
    expect(r.loopback).toBe("open")
    for (const probe of r.offLoopback) {
      expect(probe, `${probe.host} must refuse connections`).toEqual({
        host: probe.host,
        result: "closed"
      })
    }
  }))

  it.live("rejects ws upgrades without or with a wrong token and serves an authenticated client",  () => Effect.gen(function*() {
    const path = yield* Path.Path.pipe(Effect.provide(NodeServices.layer))
    const dir = yield* makeTestDirectory('expand-trust-boundary-')
    const program = Effect.gen(function* () {
      const dbPath = path.join(dir, "events.db")
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
      yield* awaitEndpointUp
      const endpoint = yield* currentEndpoint
      const noToken = yield* probeWs(endpoint.url)
      const wrongToken = yield* probeWs(`${endpoint.url}?token=wrong-token`)
      const health = yield* withClient(nodeAdapter, (client) => client.Health())
      yield* Fiber.join(serverFiber).pipe(
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () => Effect.fail("server did not shut down after last client left (I-4)")
        })
      )
      return { noToken, wrongToken, health }
    }).pipe(Effect.scoped, Effect.provide(ProcessServices.layer), Effect.provide(Layer.succeed(AppContext, makeTestAppContext(path, dir))))

    const r = yield* (program)
    expect(r.noToken).toBe("closed")
    expect(r.wrongToken).toBe("closed")
    expect(r.health).toBe("ok")
  }))

  it.live("writes the endpoint file 0600 inside a 0700 directory",  () => Effect.gen(function*() {
    const path = yield* Path.Path.pipe(Effect.provide(NodeServices.layer))
    const dir = yield* makeTestDirectory('expand-trust-boundary-')
    const home = path.join(dir, "expand-home")
    const file = makeTestAppContext(path, home).paths.endpointFile
    const program = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* writeEndpointFile({
        url: "ws://127.0.0.1:51789/rpc",
        token: "tok",
        pid: 4242,
        protocolVersion: PROTOCOL_VERSION
      })
      const fileInfo = yield* fs.stat(file)
      const dirInfo = yield* fs.stat(home)
      return { fileMode: Number(fileInfo.mode & 0o777), dirMode: Number(dirInfo.mode & 0o777) }
    }).pipe(Effect.scoped, Effect.provide(ProcessServices.layer), Effect.provide(Layer.succeed(AppContext, makeTestAppContext(path, home))))

    const r = yield* (program)
    expect(r.fileMode).toBe(0o600)
    expect(r.dirMode).toBe(0o700)
  }))

  it.live("releases endpoint file ownership when endpoint setup fails", () => Effect.gen(function*() {
    const path = yield* Path.Path.pipe(Effect.provide(NodeServices.layer))
    const dir = yield* makeTestDirectory('expand-trust-boundary-')
    const file = makeTestAppContext(path, dir).paths.endpointFile
    const exit = yield* Effect.exit(Effect.gen(function*() {
      yield* writeEndpointFile({
        url: "ws://127.0.0.1:51789/rpc",
        token: "tok",
        pid: 4242,
        protocolVersion: PROTOCOL_VERSION
      })
      return yield* Effect.fail("forced endpoint setup failure" as const)
    }).pipe(
      Effect.scoped,
      Effect.provide(ProcessServices.layer),
      Effect.provide(Layer.succeed(AppContext, makeTestAppContext(path, dir)))
    ))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(yield* FileSystem.FileSystem.pipe(
      Effect.flatMap((fs) => fs.exists(file)),
      Effect.provide(NodeServices.layer)
    )).toBe(false)
  }))

  it.live("tightens a pre-existing endpoint file to 0600",  () => Effect.gen(function*() {
    const path = yield* Path.Path.pipe(Effect.provide(NodeServices.layer))
    const dir = yield* makeTestDirectory('expand-trust-boundary-')
    const file = makeTestAppContext(path, dir).paths.endpointFile
    yield* FileSystem.FileSystem.pipe(
      Effect.flatMap((fs) => fs.writeFileString(file, "stale").pipe(Effect.andThen(fs.chmod(file, 0o644)))),
      Effect.provide(NodeServices.layer)
    )
    const program = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* writeEndpointFile({
        url: "ws://127.0.0.1:51789/rpc",
        token: "tok",
        pid: 4242,
        protocolVersion: PROTOCOL_VERSION
      })
      const info = yield* fs.stat(file)
      return Number(info.mode & 0o777)
    }).pipe(Effect.scoped, Effect.provide(ProcessServices.layer), Effect.provide(Layer.succeed(AppContext, makeTestAppContext(path, dir))))

    expect(yield* (program)).toBe(0o600)
  }))

  it.live("chmods the database file to 0600 after boot",  () => Effect.gen(function*() {
    const path = yield* Path.Path.pipe(Effect.provide(NodeServices.layer))
    const dir = yield* makeTestDirectory('expand-trust-boundary-')
    const program = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dbPath = path.join(dir, "events.db")
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
      yield* awaitEndpointUp
      const info = yield* fs.stat(dbPath)
      yield* Fiber.interrupt(serverFiber)
      return Number(info.mode & 0o777)
    }).pipe(Effect.scoped, Effect.provide(ProcessServices.layer), Effect.provide(Layer.succeed(AppContext, makeTestAppContext(path, dir))))

    expect(yield* (program)).toBe(0o600)
  }))

  it.live("secures the db, WAL, SHM, and data dir even when the ambient umask is permissive",  () => Effect.gen(function*() {
    const path = yield* Path.Path.pipe(Effect.provide(NodeServices.layer))
    const dir = yield* makeTestDirectory('expand-trust-boundary-')
    // The event store on disk IS the events the token is meant to gate. A
    // different OS user who can traverse the data dir could read the whole
    // history straight off disk, bypassing the token — so boot must leave the
    // dir 0700 and every db file 0600 regardless of the inherited umask, and
    // regardless of the data dir having been pre-created world-traversable
    // (as main.ts does before runServer runs).
    const dataDir = path.join(dir, "datadir")
    const program = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs.makeDirectory(dataDir, { recursive: true })
      const host = yield* startTrustBoundaryHost(["permissive-umask-server", dataDir])
      yield* awaitChildReadiness(awaitEndpointUp, host, "permissive umask fixture")
      yield* assertChildAlive(host, "permissive umask fixture")
      const dbPath = path.join(dataDir, "events.db")
      const mode = (p: string) => Effect.map(fs.stat(p), (s) => Number(s.mode & 0o777))
      const db = yield* mode(dbPath)
      const wal = yield* mode(`${dbPath}-wal`)
      const shm = yield* mode(`${dbPath}-shm`)
      const dirMode = yield* mode(dataDir)
      return { db, wal, shm, dirMode }
    }).pipe(Effect.scoped, Effect.provide(ProcessServices.layer), Effect.provide(Layer.succeed(AppContext, makeTestAppContext(path, dataDir))))

    const r = yield* program
    expect(r.db, "events.db must be owner-only").toBe(0o600)
    expect(r.wal, "events.db-wal must be owner-only").toBe(0o600)
    expect(r.shm, "events.db-shm must be owner-only").toBe(0o600)
    expect(r.dirMode, "data dir must be owner-only").toBe(0o700)
  }))

  it.live("rejects a same-length wrong token and accepts the real token on a raw socket",  () => Effect.gen(function*() {
    const path = yield* Path.Path.pipe(Effect.provide(NodeServices.layer))
    const dir = yield* makeTestDirectory('expand-trust-boundary-')
    const program = Effect.gen(function* () {
      const dbPath = path.join(dir, "events.db")
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
      yield* awaitEndpointUp
      const endpoint = yield* currentEndpoint
      const flipped = `${endpoint.token.slice(0, -1)}${endpoint.token.endsWith("0") ? "1" : "0"}`
      const sameLengthWrong = yield* probeWs(`${endpoint.url}?token=${encodeURIComponent(flipped)}`)
      const realToken = yield* probeWs(`${endpoint.url}?token=${encodeURIComponent(endpoint.token)}`)
      yield* Fiber.interrupt(serverFiber)
      return { sameLengthWrong, realToken }
    }).pipe(Effect.scoped, Effect.provide(ProcessServices.layer), Effect.provide(Layer.succeed(AppContext, makeTestAppContext(path, dir))))

    const r = yield* (program)
    expect(r.sameLengthWrong).toBe("closed")
    expect(r.realToken).toBe("open")
  }))
})

const makeTestDirectory = (prefix: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix })),
    Effect.provide(NodeServices.layer)
  )

const makeTestAppContext = (path: Path.Path, dataDir: string) =>
  makeAppContext(path, { homeDir: dataDir, cwd: dataDir, dataDir })
