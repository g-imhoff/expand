import { Effect, Exit, FileSystem, Layer, Scope } from "effect"
import { HttpServer } from "effect/unstable/http"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { BunServices } from "@effect/platform-bun"
import { EventStoreLayer } from "@yodea/db/event-store"
import { EventBusLayer } from "@yodea/application/event-bus"
import { ProjectProjectionLayer } from "@yodea/application/projections"
import { UseCasesLayer } from "@yodea/application/use-cases"
import { ConnectionTracker, ConnectionTrackerLayer } from "@yodea/server/connection-tracker"
import { httpServerLayer } from "@yodea/server/http"
import { writeEndpointFile } from "@yodea/server/endpoint-file"
import { PROTOCOL_VERSION } from "@yodea/shared/endpoint"
import { newId } from "@yodea/lib/ids"

export interface RunServerOptions {
  readonly dbPath: string
  // Bind hint. 0 (the default) lets the OS assign an ephemeral port; the ACTUAL
  // bound port is read back from the running HttpServer and advertised. A fixed
  // port is only useful in tests that need a predictable address.
  readonly port?: number
}

// How long we wait for the HTTP server's own scope to close gracefully before
// abandoning it (see the `httpScope` teardown in `runServer`).
const HTTP_SHUTDOWN_GRACE = "1 second"

// Domain + application services as ONE shared graph. Each `XLayer` is a stable
// memoized layer, so referencing `store` in three places yields ONE EventStore
// instance (and thus one SQLite handle, one PubSub, one tracker). v4 has no
// auto `.Default` — every service exports its layer explicitly (`Layer.effect`).
const coreLayer = (dbPath: string) => {
  const sql = SqliteClient.layer({ filename: dbPath })
  const store = EventStoreLayer.pipe(Layer.provide(sql))
  const projection = ProjectProjectionLayer.pipe(Layer.provide(store))
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
  // 0 => OS-assigned ephemeral port. The real bound port is read back below.
  const portHint = options.port ?? 0

  // `core` + `BunServices` live in the OUTER scope (this effect's `Effect.scoped`).
  // The HTTP/WebSocket transport lives in its own CHILD scope (`httpScope`) so we
  // can close it on demand — and, critically, with a deadline.
  //
  // WHY the child scope + deadline: on Bun, the `HttpServer` finalizer calls
  // graceful `server.stop()` (no force flag, and the unconditional finalizer is
  // untimed — see node_modules/@effect/platform-bun/dist/BunHttpServer.js:65-70).
  // Bun's graceful `server.stop()` only resolves once every open socket has
  // closed; during a zero-connection (I-4) shutdown the last presence WebSocket
  // is still registered with Bun at the instant teardown begins, so graceful stop
  // blocks forever and the whole scope teardown (incl. I-3 endpoint removal and
  // `Fiber.join`) deadlocks. There is no force-close knob on the `HttpServer`
  // service, so we bound the transport's teardown ourselves: we ask its scope to
  // close, give graceful stop a short grace window, then proceed regardless. The
  // OS reclaims the port on process exit; the client is already gone, so nothing
  // observable is leaked.
  //
  // `httpServerLayer` re-exports the `HttpServer` service so we can read the
  // ACTUAL bound port after binding (ephemeral ports avoid EADDRINUSE when a
  // fresh server starts while an old one is still in its grace-window teardown).
  const transportLayer = Layer.mergeAll(
    httpServerLayer(portHint).pipe(Layer.provide(core)),
    BunServices.layer
  )

  const program = Effect.gen(function* () {
    const tracker = yield* ConnectionTracker
    const fs = yield* FileSystem.FileSystem

    // Bring up the transport in a dedicated closeable scope, then read the port
    // Bun actually bound to (the OS picks it when portHint is 0).
    const httpScope = yield* Scope.make()
    const transport = yield* Layer.buildWithScope(transportLayer, httpScope)
    const address = HttpServer.HttpServer.pipe(
      Effect.map((server) => server.address),
      Effect.provide(transport)
    )
    const addr = yield* address
    const boundPort = addr._tag === "TcpAddress" ? addr.port : portHint
    const url = `ws://127.0.0.1:${boundPort}/rpc`

    // I-3: advertise the endpoint (acquireRelease removes it on outer scope close).
    const endpointFile = yield* writeEndpointFile({
      url,
      token: newId(),
      pid: process.pid,
      protocolVersion: PROTOCOL_VERSION
    })
    yield* Effect.logInfo(`yodea backend listening on ${url} (pid ${process.pid})`)

    // I-4: block until armed && connection count returns to zero.
    yield* tracker.awaitShutdown
    yield* Effect.logInfo("last connection closed — shutting down")

    // Eager I-3 removal: delete the discovery file the INSTANT shutdown is armed,
    // BEFORE the grace-window transport teardown. Otherwise a back-to-back command
    // issued during that ~1s window reads the stale file, connects to this dying
    // server, and hangs. The acquireRelease finalizer remains as an idempotent
    // backup (it ignores a missing file).
    yield* fs.remove(endpointFile).pipe(Effect.ignore)

    // Close the transport's scope, but never let Bun's graceful `server.stop()`
    // deadlock the shutdown. After the grace window we move on; the outer scope
    // then removes the endpoint file (I-3, idempotent) and the fiber completes (I-4).
    yield* Scope.close(httpScope, Exit.void).pipe(
      Effect.timeoutOrElse({
        duration: HTTP_SHUTDOWN_GRACE,
        orElse: () =>
          Effect.logInfo("http server did not stop within grace window — abandoning")
      })
    )
  })

  // `core` is shared between the transport (handlers) and the program (tracker),
  // so the count the handlers mutate is the count the program awaits.
  //
  // NOTE: this effect COMPLETES after a clean I-4 shutdown but does NOT force the
  // OS process to exit — that is the responsibility of the real process entry
  // point (`apps/cli/cli/commands/server.ts`), so in-process callers (tests) can
  // run `runServer` and observe completion without killing the test runner. See
  // the exit rationale documented there.
  return program.pipe(
    Effect.provide(Layer.mergeAll(core, BunServices.layer)),
    Effect.scoped
  )
}
