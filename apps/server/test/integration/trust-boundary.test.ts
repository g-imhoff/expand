import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect, Exit, Fiber, FileSystem, Layer, Option, Schedule, Scope } from "effect"
import { HttpServer } from "effect/unstable/http"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { connect } from "node:net"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { networkInterfaces, tmpdir } from "node:os"
import { join } from "node:path"
import { runServer } from "@expand/server/composition/app"
import { writeEndpointFile } from "@expand/server/endpoint-file"
import { PROTOCOL_VERSION } from "@expand/contracts/endpoint"
import { makeTestAppContext } from "@expand/contracts/app-context.testkit"
import { httpServerLayer } from "@expand/server/http"
import { ReplayFeedLayer } from "@expand/server/db/replay-feed"
import { EventBusLayer } from "@expand/server/application/event-bus"
import { ProjectProjectionLayer } from "@expand/server/application/projections"
import { ProjectEventStoreLayer } from "@expand/server/application/projects/project-event-store"
import { ProjectionStateStoreLayer } from "@expand/server/db/projection-state-store"
import { ProjectUseCasesLayer } from "@expand/server/application/projects/use-cases"
import { ServerUseCasesLayer } from "@expand/server/application/server/use-cases"
import { ConnectionTrackerLayer } from "@expand/server/connection-tracker"
import { readEndpoint } from "@expand/client-core/discovery"
import { withClient } from "@expand/client-core"
import { bunAdapter } from "@expand/client-core/adapters/bun"
import { endpointWsUrl } from "@expand/client-core/rpc-client"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "expand-trust-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const awaitEndpointUp = readEndpoint.pipe(
  Effect.flatMap((o) => (Option.isSome(o) ? Effect.void : Effect.fail("pending" as const))),
  Effect.retry(Schedule.spaced("25 millis")),
  Effect.timeoutOrElse({
    duration: "5 seconds",
    orElse: () => Effect.fail(new Error("server never advertised an endpoint (I-3)"))
  })
)

const currentEndpoint = readEndpoint.pipe(
  Effect.flatMap((o) =>
    Option.isSome(o) ? Effect.succeed(o.value) : Effect.fail(new Error("endpoint file missing"))
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
    Layer.provide(BunFileSystem.layer),
    Layer.provide(BunServices.layer)
  )
  return Layer.mergeAll(projectUseCases, ServerUseCasesLayer, EventBusLayer, ConnectionTrackerLayer, projection, replay)
}

const probeTcp = (host: string, port: number): Promise<"open" | "closed"> =>
  new Promise((resolve) => {
    const socket = connect({ host, port })
    const timer = setTimeout(() => done("closed"), 2000)
    const done = (result: "open" | "closed") => {
      clearTimeout(timer)
      socket.destroy()
      resolve(result)
    }
    socket.once("connect", () => done("open"))
    socket.once("error", () => done("closed"))
  })

const offLoopbackTargets = (): ReadonlyArray<string> => [
  "::1",
  ...Object.values(networkInterfaces()).flatMap((infos) =>
    (infos ?? []).filter((i) => !i.internal && i.family === "IPv4").map((i) => i.address)
  )
]

const probeWs = (url: string): Promise<"open" | "closed"> =>
  new Promise((resolve) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => {
      resolve("closed")
      ws.close()
    }, 2000)
    ws.addEventListener("open", () => {
      clearTimeout(timer)
      resolve("open")
      ws.close()
    })
    ws.addEventListener("error", () => {
      clearTimeout(timer)
      resolve("closed")
    })
    ws.addEventListener("close", () => {
      clearTimeout(timer)
      resolve("closed")
    })
  })

describe.sequential("trust boundary", () => {
  it("binds to a 127.0.0.1 TcpAddress", async () => {
    const program = Effect.gen(function* () {
      const transport = yield* Layer.build(
        Layer.mergeAll(
          httpServerLayer(0, "trust-boundary-token").pipe(Layer.provide(testCore(join(dir, "bind.db")))),
          BunServices.layer
        )
      )
      const server = yield* HttpServer.HttpServer.pipe(Effect.provide(transport))
      const addr = server.address
      return addr._tag === "TcpAddress" ? addr.hostname : `unexpected:${addr._tag}`
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.provide(makeTestAppContext(dir).layer))

    const hostname = await Effect.runPromise(program)
    expect(hostname).toBe("127.0.0.1")
  })

  it("advertises 127.0.0.1 and is unreachable off IPv4 loopback", async () => {
    const program = Effect.gen(function* () {
      const dbPath = join(dir, "events.db")
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
      yield* awaitEndpointUp
      const endpoint = yield* currentEndpoint
      const advertisedHost = new URL(endpoint.url).hostname
      const port = Number(new URL(endpoint.url).port)
      const loopback = yield* Effect.promise(() => probeTcp("127.0.0.1", port))
      const offLoopback = yield* Effect.promise(() =>
        Promise.all(
          offLoopbackTargets().map(async (host) => ({ host, result: await probeTcp(host, port) }))
        )
      )
      yield* Fiber.interrupt(serverFiber)
      return { advertisedHost, loopback, offLoopback }
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.provide(makeTestAppContext(dir).layer))

    const r = await Effect.runPromise(program)
    expect(r.advertisedHost).toBe("127.0.0.1")
    expect(r.loopback).toBe("open")
    for (const probe of r.offLoopback) {
      expect(probe, `${probe.host} must refuse connections`).toEqual({
        host: probe.host,
        result: "closed"
      })
    }
  })

  it("rejects ws upgrades without or with a wrong token and serves an authenticated client", async () => {
    const program = Effect.gen(function* () {
      const dbPath = join(dir, "events.db")
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
      yield* awaitEndpointUp
      const endpoint = yield* currentEndpoint
      const noToken = yield* Effect.promise(() => probeWs(endpoint.url))
      const wrongToken = yield* Effect.promise(() => probeWs(`${endpoint.url}?token=wrong-token`))
      const health = yield* withClient(bunAdapter, (client) => client.Health())
      yield* Fiber.join(serverFiber).pipe(
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () => Effect.fail(new Error("server did not shut down after last client left (I-4)"))
        })
      )
      return { noToken, wrongToken, health }
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.provide(makeTestAppContext(dir).layer))

    const r = await Effect.runPromise(program)
    expect(r.noToken).toBe("closed")
    expect(r.wrongToken).toBe("closed")
    expect(r.health).toBe("ok")
  })

  it("writes the endpoint file 0600 inside a 0700 directory", async () => {
    const home = join(dir, "expand-home")
    const file = makeTestAppContext(home).paths.endpointFile
    const program = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const scope = yield* Scope.make()
      yield* Effect.provideService(
        writeEndpointFile({
          url: "ws://127.0.0.1:51789/rpc",
          token: "tok",
          pid: 4242,
          protocolVersion: PROTOCOL_VERSION
        }),
        Scope.Scope,
        scope
      )
      const fileInfo = yield* fs.stat(file)
      const dirInfo = yield* fs.stat(home)
      yield* Scope.close(scope, Exit.void)
      return { fileMode: Number(fileInfo.mode & 0o777), dirMode: Number(dirInfo.mode & 0o777) }
    }).pipe(Effect.provide(BunServices.layer), Effect.provide(makeTestAppContext(home).layer))

    const r = await Effect.runPromise(program)
    expect(r.fileMode).toBe(0o600)
    expect(r.dirMode).toBe(0o700)
  })

  it("tightens a pre-existing endpoint file to 0600", async () => {
    const file = makeTestAppContext(dir).paths.endpointFile
    writeFileSync(file, "stale", { mode: 0o644 })
    const program = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const scope = yield* Scope.make()
      yield* Effect.provideService(
        writeEndpointFile({
          url: "ws://127.0.0.1:51789/rpc",
          token: "tok",
          pid: 4242,
          protocolVersion: PROTOCOL_VERSION
        }),
        Scope.Scope,
        scope
      )
      const info = yield* fs.stat(file)
      yield* Scope.close(scope, Exit.void)
      return Number(info.mode & 0o777)
    }).pipe(Effect.provide(BunServices.layer), Effect.provide(makeTestAppContext(dir).layer))

    expect(await Effect.runPromise(program)).toBe(0o600)
  })

  it("chmods the database file to 0600 after boot", async () => {
    const program = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dbPath = join(dir, "events.db")
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
      yield* awaitEndpointUp
      const info = yield* fs.stat(dbPath)
      yield* Fiber.interrupt(serverFiber)
      return Number(info.mode & 0o777)
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.provide(makeTestAppContext(dir).layer))

    expect(await Effect.runPromise(program)).toBe(0o600)
  })

  it("rejects a same-length wrong token and accepts the real token on a raw socket", async () => {
    const program = Effect.gen(function* () {
      const dbPath = join(dir, "events.db")
      const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
      yield* awaitEndpointUp
      const endpoint = yield* currentEndpoint
      const flipped = `${endpoint.token.slice(0, -1)}${endpoint.token.endsWith("0") ? "1" : "0"}`
      const sameLengthWrong = yield* Effect.promise(() =>
        probeWs(`${endpoint.url}?token=${encodeURIComponent(flipped)}`)
      )
      const realToken = yield* Effect.promise(() => probeWs(endpointWsUrl(endpoint)))
      yield* Fiber.interrupt(serverFiber)
      return { sameLengthWrong, realToken }
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.provide(makeTestAppContext(dir).layer))

    const r = await Effect.runPromise(program)
    expect(r.sameLengthWrong).toBe("closed")
    expect(r.realToken).toBe("open")
  })
})
