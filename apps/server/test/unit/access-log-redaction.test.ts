import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, Fiber, Queue, FileSystem, Layer, Logger, Path, References, Schedule, Schema } from "effect"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import * as Socket from "effect/unstable/socket/Socket"
import { HttpServer } from "effect/unstable/http"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { NodeFileSystem, NodeServices } from "@effect/platform-node"
import { httpServerLayer } from "@expand/server/transport/http-server"
import { ReplayFeedLayer } from "@expand/server/db/replay-feed"
import { EventBusLayer } from "@expand/server/application/event-bus"
import { ProjectProjectionLayer } from "@expand/server/application/projections"
import { ProjectEventStoreLayer } from "@expand/server/application/projects/project-event-store"
import { ProjectionStateStoreLayer } from "@expand/server/db/projection-state-store"
import { ProjectUseCasesLayer } from "@expand/server/application/projects/use-cases"
import { ServerUseCasesLayer } from "@expand/server/application/server/use-cases"
import { ConnectionTrackerLayer } from "@expand/server/runtime/connection-tracker"
import { DatabaseReadyLayer } from "@expand/server/migrations/sqlite"

// mirrors coreLayer in composition/app.ts (not exported)
const testCore = (dbPath: string) => {
  const sql = SqliteClient.layer({ filename: dbPath })
  const database = DatabaseReadyLayer.pipe(Layer.provideMerge(sql))
  const replay = ReplayFeedLayer.pipe(Layer.provide(database))
  const projectEvents = ProjectEventStoreLayer.pipe(Layer.provide(database))
  const states = ProjectionStateStoreLayer.pipe(Layer.provide(database))
  const projection = ProjectProjectionLayer.pipe(Layer.provide(projectEvents), Layer.provide(states))
  const projectUseCases = ProjectUseCasesLayer.pipe(
    Layer.provide(projectEvents),
    Layer.provide(EventBusLayer),
    Layer.provide(projection),
    Layer.provide(NodeFileSystem.layer),
    Layer.provide(NodeServices.layer)
  )
  return Layer.mergeAll(projectUseCases, ServerUseCasesLayer, EventBusLayer, ConnectionTrackerLayer, projection, replay)
}

const probeWs = (url: string) =>
  Effect.scoped(Effect.gen(function*() {
    const opened = yield* Queue.unbounded<void>()
    const socket = yield* Socket.makeWebSocket(url, { openTimeout: "2 seconds" }).pipe(
      Effect.provide(NodeSocket.layerWebSocketConstructorWS)
    )
    const run = yield* socket.runRaw(() => undefined, {
      onOpen: Queue.offer(opened, undefined)
    }).pipe(Effect.forkScoped)
    return yield* Effect.race(
      Queue.take(opened).pipe(Effect.as("open" as const)),
      Fiber.join(run).pipe(
        Effect.as("closed" as const),
        Effect.catchCause(() => Effect.succeed("closed" as const))
      )
    ).pipe(Effect.timeoutOrElse({
      duration: "2 seconds",
      orElse: () => Effect.succeed("closed" as const)
    }))
  }))

describe("access log redaction", () => {
  it.live("never writes the rpc token into http.url log annotations",  () => Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer))
    const path = yield* Path.Path.pipe(Effect.provide(NodeServices.layer))
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "expand-redact-" })
    const records: Array<Record<string, unknown>> = []
    const token = "trust-boundary-token"
    const captureLogger = Logger.make(({ fiber }) => {
      records.push({ ...fiber.getRef(References.CurrentLogAnnotations) })
    })
    const rpcRecords = () => records.filter((r) => String(r["http.url"] ?? "").startsWith("/rpc"))

    const program = Effect.gen(function* () {
      const transport = yield* Layer.build(
        Layer.mergeAll(
          httpServerLayer(0, token).pipe(
            Layer.provide(testCore(path.join(dir, "redact.db")))
          ),
          NodeServices.layer
        ).pipe(
          Layer.provide(Logger.layer([captureLogger])),
          Layer.provide(Layer.succeed(References.MinimumLogLevel)("Debug"))
        )
      )
      const server = yield* HttpServer.HttpServer.pipe(Effect.provide(transport))
      const addr = server.address
      const port = addr._tag === "TcpAddress" ? addr.port : 0
      const opened = yield* probeWs(`ws://127.0.0.1:${port}/rpc?token=${token}`)
      yield* Effect.suspend(() =>
        rpcRecords().length > 0 ? Effect.void : Effect.fail("pending" as const)
      ).pipe(
        Effect.retry(Schedule.spaced("25 millis")),
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () => Effect.fail("no /rpc access-log record was captured")
        })
      )
      const hostname = addr._tag === "TcpAddress" ? addr.hostname : `unexpected:${addr._tag}`
      return { hostname, opened }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

    const { hostname, opened } = yield* program
    const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))
    const logOutput = yield* encode(records)
      expect(opened).toBe("open")
      expect(hostname).toBe("127.0.0.1")
      expect(rpcRecords().length).toBeGreaterThan(0)
      expect(logOutput).not.toContain(token)
      expect(logOutput).toContain("/rpc")
      for (const annotations of records) {
        expect(yield* encode(annotations)).not.toContain("token=")
      }
  }).pipe(Effect.scoped))
})
