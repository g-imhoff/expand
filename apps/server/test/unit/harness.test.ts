import { NodeServices } from "@effect/platform-node"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { it } from "@effect/vitest"
import { Effect, Exit, Fiber, FileSystem, Layer, Option, Path, Queue, Schedule, Stream } from "effect"
import { HttpServer } from "effect/unstable/http"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { ChildProcess } from "effect/unstable/process"
import * as Socket from "effect/unstable/socket/Socket"
import { describe, expect } from "vitest"
import { readEndpoint } from "@expand/client-ts"
import { ProcessServices } from "@expand/client-ts/adapters/node"
import { EventBusLayer } from "@expand/server/application/event-bus"
import { ProjectProjectionLayer } from "@expand/server/application/projections"
import { ProjectEventStoreLayer } from "@expand/server/application/projects/project-event-store"
import { ProjectUseCasesLayer } from "@expand/server/application/projects/use-cases"
import { ServerUseCasesLayer } from "@expand/server/application/server/use-cases"
import { ConnectionTrackerLayer } from "@expand/server/runtime/connection-tracker"
import { ReplayFeedLayer } from "@expand/server/db/replay-feed"
import { ProjectionStateStoreLayer } from "@expand/server/db/projection-state-store"
import { httpServerLayer } from "@expand/server/transport/http-server"
import { AppContext, makeAppContext } from "@expand/contracts/app-context"
import { ProcessControl } from "@expand/contracts/process-control"
import { makeTempDirectoryScoped } from "../../../../test/support/effect-files"
import { DatabaseReadyLayer } from "@expand/server/migrations/sqlite"

const probeTcp = (host: string, port: number) =>
  Effect.scoped(Effect.gen(function*() {
    const socket = yield* NodeSocket.makeNet({ host, port, openTimeout: "1 second" })
    const opened = yield* Queue.unbounded<void>()
    const run = yield* socket.runRaw(() => undefined, {
      onOpen: Queue.offer(opened, undefined)
    }).pipe(Effect.forkScoped)
    return yield* Effect.race(
      Queue.take(opened).pipe(Effect.as(true)),
      Fiber.join(run).pipe(Effect.as(false), Effect.catchCause(() => Effect.succeed(false)))
    ).pipe(Effect.timeoutOrElse({ duration: "1 second", orElse: () => Effect.succeed(false) }))
  }))

const harnessServerLayer = (dbPath: string) => {
  const sql = SqliteClient.layer({ filename: dbPath })
  const database = DatabaseReadyLayer.pipe(Layer.provideMerge(sql))
  const replay = ReplayFeedLayer.pipe(Layer.provide(database))
  const projectEvents = ProjectEventStoreLayer.pipe(Layer.provide(database))
  const states = ProjectionStateStoreLayer.pipe(Layer.provide(database))
  const projection = ProjectProjectionLayer.pipe(Layer.provide(projectEvents), Layer.provide(states))
  const projectUseCases = ProjectUseCasesLayer.pipe(
    Layer.provide(projectEvents),
    Layer.provide(EventBusLayer),
    Layer.provide(projection)
  )
  const core = Layer.mergeAll(
    projectUseCases,
    ServerUseCasesLayer,
    EventBusLayer,
    ConnectionTrackerLayer,
    projection,
    replay
  )
  return Layer.mergeAll(httpServerLayer(0, "harness-token").pipe(Layer.provide(core)), database)
}

const makeHarnessFixture = Effect.gen(function*() {
  const path = yield* Path.Path
  const directory = yield* makeTempDirectoryScoped("expand-server-harness-")
  const context = makeAppContext(path, { homeDir: directory, cwd: directory, dataDir: directory })
  const serverContext = yield* Layer.build(harnessServerLayer(path.join(directory, "server-layer.db"))).pipe(
    Effect.provide(Layer.succeed(AppContext, context))
  )
  const server = yield* HttpServer.HttpServer.pipe(Effect.provide(serverContext))
  const sql = yield* SqlClient.pipe(Effect.provide(serverContext))
  const address = server.address
  const serverPort = address._tag === "TcpAddress" ? address.port : 0
  const handle = yield* ChildProcess.make(
    "node",
    ["--import", "tsx", "apps/server/main.ts", "--data-dir", directory],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" }
  )
  yield* Effect.forkScoped(Stream.runDrain(handle.stdout))
  yield* Effect.forkScoped(Stream.runDrain(handle.stderr))
  const endpoint = yield* readEndpoint.pipe(
    Effect.flatMap((option) => Option.isSome(option) ? Effect.succeed(option.value) : Effect.fail("pending" as const)),
    Effect.retry(Schedule.spaced("25 millis")),
    Effect.timeout("5 seconds"),
    Effect.provide(Layer.succeed(AppContext, context))
  )
  const opened = yield* Queue.unbounded<void>()
  const socket = yield* Socket.makeWebSocket(`${endpoint.url}?token=${encodeURIComponent(endpoint.token)}`).pipe(
    Effect.provide(NodeSocket.layerWebSocketConstructorWS)
  )
  const socketFiber = yield* socket.runRaw(() => undefined, {
    onOpen: Queue.offer(opened, undefined)
  }).pipe(Effect.forkScoped)
  yield* Queue.take(opened).pipe(Effect.timeout("5 seconds"))
  return { directory, endpoint, handle, serverPort, socketFiber, sql }
})

type HarnessFixture = Effect.Success<typeof makeHarnessFixture>

const verifyFixtureOpen = Effect.fn("Harness.verifyFixtureOpen")(function*(fixture: HarnessFixture) {
  const processControl = yield* ProcessControl
  expect(yield* processControl.probe(Number(fixture.handle.pid))).toBe("alive")
  expect(yield* probeTcp("127.0.0.1", Number(new URL(fixture.endpoint.url).port))).toBe(true)
  expect(yield* probeTcp("127.0.0.1", fixture.serverPort)).toBe(true)
  expect(yield* fixture.sql<{ readonly value: number }>`SELECT 1 AS value`).toEqual([{ value: 1 }])
})

const verifyFixtureClosed = Effect.fn("Harness.verifyFixtureClosed")(function*(fixture: HarnessFixture) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const processControl = yield* ProcessControl
  yield* fixture.handle.exitCode.pipe(Effect.timeout("5 seconds"))
  expect(yield* processControl.probe(Number(fixture.handle.pid))).toBe("dead")
  expect(yield* probeTcp("127.0.0.1", Number(new URL(fixture.endpoint.url).port))).toBe(false)
  expect(yield* probeTcp("127.0.0.1", fixture.serverPort)).toBe(false)
  expect(fixture.socketFiber.pollUnsafe()?._tag).toBe("Failure")
  expect(Exit.isFailure(yield* Effect.exit(fixture.sql`SELECT 1`))).toBe(true)
  expect(yield* fs.exists(path.join(fixture.directory, "events.db"))).toBe(false)
  expect(yield* fs.exists(fixture.directory)).toBe(false)
})

const TestServices = Layer.mergeAll(ProcessServices.layer, NodeServices.layer)

describe("test harness", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2)
  })

  it.live("finalizes the database, server, listener, socket, child process, and temporary directory on failure", () =>
    Effect.gen(function*() {
      const acquired = yield* Queue.unbounded<HarnessFixture>()
      const exit = yield* Effect.exit(Effect.scoped(
        makeHarnessFixture.pipe(
          Effect.tap((fixture) => Queue.offer(acquired, fixture)),
          Effect.tap(verifyFixtureOpen),
          Effect.andThen(Effect.fail("forced assertion failure" as const))
        )
      ))
      const fixture = yield* Queue.take(acquired)
      expect(Exit.isFailure(exit)).toBe(true)
      yield* verifyFixtureClosed(fixture)
    }).pipe(Effect.provide(TestServices)))

  it.live("finalizes the database, server, listener, socket, child process, and temporary directory on interruption", () =>
    Effect.gen(function*() {
      const acquired = yield* Queue.unbounded<HarnessFixture>()
      const worker = yield* makeHarnessFixture.pipe(
        Effect.tap((fixture) => Queue.offer(acquired, fixture)),
        Effect.tap(verifyFixtureOpen),
        Effect.andThen(Effect.never),
        Effect.scoped,
        Effect.forkChild
      )
      const fixture = yield* Queue.take(acquired)
      yield* Fiber.interrupt(worker)
      yield* verifyFixtureClosed(fixture)
    }).pipe(Effect.provide(TestServices)))
})
