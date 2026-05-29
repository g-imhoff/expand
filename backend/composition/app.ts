import { Effect, Layer } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { BunServices } from "@effect/platform-bun"
import { EventStoreLayer } from "@yodea/db/event-store"
import { EventBusLayer } from "@yodea/application/event-bus"
import { SessionProjectionLayer } from "@yodea/application/projections"
import { UseCasesLayer } from "@yodea/application/use-cases"
import { ConnectionTracker, ConnectionTrackerLayer } from "@yodea/server/connection-tracker"
import { httpServerLayer } from "@yodea/server/http"
import { writeEndpointFile } from "@yodea/server/endpoint-file"
import { PROTOCOL_VERSION } from "@yodea/shared/endpoint"
import { newId } from "@yodea/lib/ids"

export interface RunServerOptions {
  readonly dbPath: string
  readonly port: number
}

// Domain + application services as ONE shared graph. Each `XLayer` is a stable
// memoized layer, so referencing `store` in three places yields ONE EventStore
// instance (and thus one SQLite handle, one PubSub, one tracker). v4 has no
// auto `.Default` — every service exports its layer explicitly (`Layer.effect`).
const coreLayer = (dbPath: string) => {
  const sql = SqliteClient.layer({ filename: dbPath })
  const store = EventStoreLayer.pipe(Layer.provide(sql))
  const projection = SessionProjectionLayer.pipe(Layer.provide(store))
  const useCases = UseCasesLayer.pipe(
    Layer.provide(store),
    Layer.provide(EventBusLayer),
    Layer.provide(projection)
  )
  // The RPC handlers depend on exactly these three.
  return Layer.mergeAll(useCases, EventBusLayer, ConnectionTrackerLayer)
}

export const runServer = (options: RunServerOptions) => {
  const core = coreLayer(options.dbPath)
  const url = `ws://127.0.0.1:${options.port}/rpc`

  const program = Effect.gen(function* () {
    const tracker = yield* ConnectionTracker
    // I-3: advertise the endpoint (acquireRelease removes it on scope close).
    yield* writeEndpointFile({
      url,
      token: newId(),
      pid: process.pid,
      protocolVersion: PROTOCOL_VERSION
    })
    yield* Effect.logInfo(`yodea backend listening on ${url} (pid ${process.pid})`)
    // I-4: block until armed && connection count returns to zero.
    yield* tracker.awaitShutdown
    yield* Effect.logInfo("last connection closed — shutting down")
  })

  // `core` is shared between the transport (handlers) and the program (tracker),
  // so the count the handlers mutate is the count the program awaits.
  return program.pipe(
    Effect.provide(
      Layer.mergeAll(
        httpServerLayer(options.port).pipe(Layer.provide(core)),
        core,
        BunServices.layer
      )
    ),
    Effect.scoped
  )
}
