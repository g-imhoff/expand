import { Effect, Exit, FileSystem, Layer, Scope } from "effect"
import { dirname } from "node:path"
import { HttpServer } from "effect/unstable/http"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { NodeFileSystem, NodeServices } from "@effect/platform-node"
import { ReplayFeedLayer } from "@expand/server/db/replay-feed"
import { ProjectEventStoreLayer } from "@expand/server/application/projects/project-event-store"
import { EventBusLayer } from "@expand/server/application/event-bus"
import { ProjectProjectionLayer } from "@expand/server/application/projections"
import { ProjectionStateStoreLayer } from "@expand/server/db/projection-state-store"
import { ProjectUseCasesLayer } from "@expand/server/application/projects/use-cases"
import { ServerUseCasesLayer } from "@expand/server/application/server/use-cases"
import { ConnectionTracker, ConnectionTrackerLayer } from "@expand/server/connection-tracker"
import { httpServerLayer } from "@expand/server/http"
import { writeEndpointFile } from "@expand/server/endpoint-file"
import { PROTOCOL_VERSION } from "@expand/contracts/endpoint"
import { newId } from "@expand/server/lib/ids"

export interface RunServerOptions {
  readonly dbPath: string
  readonly port?: number
}

export const runServer = (options: RunServerOptions) => {
  const core = coreLayer(options.dbPath)
  const portHint = options.port ?? 0
  const token = newId()

  const transportLayer = Layer.mergeAll(
    httpServerLayer(portHint, token).pipe(Layer.provide(core)),
    NodeServices.layer
  )

  const program = Effect.gen(function*() {
    const tracker = yield* ConnectionTracker
    const fs = yield* FileSystem.FileSystem

    const httpScope = yield* Scope.make()
    const transport = yield* Layer.buildWithScope(transportLayer, httpScope)
    const address = HttpServer.HttpServer.pipe(
      Effect.map((server) => server.address),
      Effect.provide(transport)
    )
    const addr = yield* address
    const boundPort = addr._tag === "TcpAddress" ? addr.port : portHint
    const url = `ws://127.0.0.1:${boundPort}/rpc`

    yield* fs.chmod(dirname(options.dbPath), 0o700)
    yield* fs.chmod(options.dbPath, 0o600)
    yield* secureIfPresent(fs, `${options.dbPath}-wal`)
    yield* secureIfPresent(fs, `${options.dbPath}-shm`)

    const endpointFile = yield* writeEndpointFile({
      url,
      token,
      pid: process.pid,
      protocolVersion: PROTOCOL_VERSION
    })
    yield* Effect.logInfo(`expand backend listening on ${url} (pid ${process.pid})`)

    yield* tracker.awaitShutdown
    yield* Effect.logInfo("last connection closed — shutting down")

    yield* fs.remove(endpointFile).pipe(Effect.ignore)

    yield* Scope.close(httpScope, Exit.void).pipe(
      Effect.timeoutOrElse({
        duration: HTTP_SHUTDOWN_GRACE,
        orElse: () =>
          Effect.logInfo("http server did not stop within grace window — abandoning")
      })
    )
  })

  return program.pipe(
    Effect.provide(Layer.mergeAll(core, NodeServices.layer)),
    Effect.scoped
  )
}

const HTTP_SHUTDOWN_GRACE = "1 second"

const secureIfPresent = (fs: FileSystem.FileSystem, path: string) =>
  Effect.flatMap(fs.exists(path), (present) => (present ? fs.chmod(path, 0o600) : Effect.void))

const coreLayer = (dbPath: string) => {
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
    Layer.provide(NodeServices.layer)
  )
  return Layer.mergeAll(projectUseCases, ServerUseCasesLayer, EventBusLayer, ConnectionTrackerLayer, projection, replay)
}
