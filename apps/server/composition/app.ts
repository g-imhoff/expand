import { Effect, Exit, FileSystem, Layer, Scope } from "effect"
import { HttpServer } from "effect/unstable/http"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { EventStoreLayer } from "@yodea/server/db/event-store"
import { EventBusLayer } from "@yodea/server/application/event-bus"
import { ProjectProjectionLayer } from "@yodea/server/application/projections"
import { ProjectUseCasesLayer } from "@yodea/server/application/projects/use-cases"
import { ServerUseCasesLayer } from "@yodea/server/application/server/use-cases"
import { ConnectionTracker, ConnectionTrackerLayer } from "@yodea/server/connection-tracker"
import { httpServerLayer } from "@yodea/server/http"
import { writeEndpointFile } from "@yodea/server/endpoint-file"
import { PROTOCOL_VERSION } from "@yodea/contracts/endpoint"
import { newId } from "@yodea/server/lib/ids"

export interface RunServerOptions {
  readonly dbPath: string
  readonly port?: number
}

const HTTP_SHUTDOWN_GRACE = "1 second"

const coreLayer = (dbPath: string) => {
  const sql = SqliteClient.layer({ filename: dbPath })
  const store = EventStoreLayer.pipe(Layer.provide(sql))
  const projection = ProjectProjectionLayer.pipe(Layer.provide(store))
  const projectUseCases = ProjectUseCasesLayer.pipe(
    Layer.provide(store),
    Layer.provide(EventBusLayer),
    Layer.provide(projection),
    Layer.provide(BunFileSystem.layer),
    Layer.provide(BunServices.layer)
  )
  return Layer.mergeAll(projectUseCases, ServerUseCasesLayer, EventBusLayer, ConnectionTrackerLayer)
}

export const runServer = (options: RunServerOptions) => {
  const core = coreLayer(options.dbPath)
  const portHint = options.port ?? 0

  const transportLayer = Layer.mergeAll(
    httpServerLayer(portHint).pipe(Layer.provide(core)),
    BunServices.layer
  )

  const program = Effect.gen(function* () {
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

    const endpointFile = yield* writeEndpointFile({
      url,
      token: newId(),
      pid: process.pid,
      protocolVersion: PROTOCOL_VERSION
    })
    yield* Effect.logInfo(`yodea backend listening on ${url} (pid ${process.pid})`)

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
    Effect.provide(Layer.mergeAll(core, BunServices.layer)),
    Effect.scoped
  )
}
