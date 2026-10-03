import { Context, Effect, Exit, Fiber, FileSystem, Layer, Path, Scope } from "effect"
import { HttpClient, HttpServer } from "effect/http"
import { NetAddress } from "effect/net"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { NodeHttpClient } from "@effect/platform-node"
import { ReplayFeedLayer } from "@expand/server/db/replay-feed"
import { ProjectEventStoreLayer } from "@expand/server/application/projects/project-event-store"
import { EventBusLayer } from "@expand/server/application/event-bus"
import { ProjectProjectionLayer } from "@expand/server/application/projections"
import { ProjectionStateStoreLayer } from "@expand/server/db/projection-state-store"
import { ProjectUseCasesLayer } from "@expand/server/application/projects/use-cases"
import { ServerUseCasesLayer } from "@expand/server/application/server/use-cases"
import { ConnectionTracker, ConnectionTrackerLayer } from "@expand/server/runtime/connection-tracker"
import { httpServerLayer } from "@expand/server/transport/http-server"
import { removeEndpointFile, writeEndpointFile } from "@expand/server/runtime/endpoint-file"
import { PROTOCOL_VERSION } from "@expand/contracts/rpc/version"
import { newId } from "@expand/server/application/ids"
import { ProcessControl } from "@expand/contracts/process-control"
import { DatabaseReadyLayer } from "@expand/server/migrations/sqlite"
import { ConfigurationRepository, ConfigurationRepositoryLayer } from "@expand/server/automation/configuration-repository"
import { CredentialRepository, CredentialRepositoryLayer } from "@expand/server/automation/credential-repository"
import { ExecutionRepositoryLayer } from "@expand/server/automation/execution-repository"
import { AutomationRegistry } from "@expand/server/automation/registry"
import { makeGithubServerExtension } from "@expand/server/automation/github-client"
import { RoutineServiceLayer } from "@expand/server/automation/routine-service"
import { AutomationWorker, AutomationWorkerLayer } from "@expand/server/automation/worker"

export interface RunServerOptions {
  readonly dbPath: string
  readonly port?: number
  readonly keepRunning?: boolean
}

export const ServerComposition = Context.Reference<{ readonly coreLayer: Layer.Layer<never> }>("expand/ServerComposition", {
  defaultValue: () => ({ coreLayer: Layer.empty })
})

export const runServer = Effect.fn("Server.run")(function*(options: RunServerOptions) {
  const dbPath = options.dbPath
  const portHint = options.port ?? 0
  const token = yield* newId()
  const processControl = yield* ProcessControl
  const pid = processControl.currentPid
  const path = yield* Path.Path
  const composition = yield* ServerComposition
  const coreLayerDefinition = Layer.merge(coreLayer(dbPath), composition.coreLayer)

  const program = Effect.gen(function*() {
    const parentScope = yield* Scope.Scope
    const coreScope = yield* Scope.make()
    yield* Scope.addFinalizerExit(parentScope, (exit) => Scope.close(coreScope, exit))
    const core = yield* Layer.buildWithScope(coreLayerDefinition, coreScope)
    const httpScope = yield* Scope.make()
    yield* Scope.addFinalizerExit(parentScope, (exit) => closeHttpScope(httpScope, exit))
    const transport = yield* Layer.buildWithScope(
      httpServerLayer(portHint, token).pipe(Layer.provide(Layer.succeedContext(core))),
      httpScope
    )
    const worker = yield* AutomationWorker.pipe(Effect.provide(core))
    yield* Effect.forkScoped(worker.runLoop())

    const lifecycle = Effect.gen(function*() {
      const tracker = yield* ConnectionTracker
      const fs = yield* FileSystem.FileSystem
      const address = HttpServer.HttpServer.pipe(
        Effect.map((server) => server.address),
        Effect.provide(transport)
      )
      const addr = yield* address
      const boundPort = NetAddress.isInetAddress(addr) ? addr.port : portHint
      const url = `ws://127.0.0.1:${boundPort}/rpc`

      yield* fs.chmod(path.dirname(dbPath), 0o700)
      yield* fs.chmod(dbPath, 0o600)
      yield* secureIfPresent(fs, `${dbPath}-wal`)
      yield* secureIfPresent(fs, `${dbPath}-shm`)

      const endpointFile = yield* writeEndpointFile({
        url,
        token,
        pid,
        protocolVersion: PROTOCOL_VERSION
      })
      yield* Effect.logInfo(`expand backend listening on ${url} (pid ${pid})`)

      if (options.keepRunning === true) {
        return yield* Effect.never
      } else {
        yield* tracker.awaitShutdown
        yield* Effect.logInfo("last connection closed — shutting down")

        yield* removeEndpointFile(fs, endpointFile)

        yield* closeHttpScope(httpScope, Exit.void)
      }
    })

    return yield* lifecycle.pipe(Effect.provide(core))
  })

  return yield* program.pipe(Effect.scoped)
})

const HTTP_SHUTDOWN_GRACE = "1 second"

const closeHttpScope = Effect.fn("Server.closeHttpScope")((
  scope: Scope.Closeable,
  exit: Exit.Exit<unknown, unknown>
): Effect.Effect<void> =>
  Effect.uninterruptibleMask(() =>
    Effect.gen(function*() {
      const closing = yield* Effect.forkDetach(
        Scope.close(scope, exit),
        { startImmediately: true, uninterruptible: true }
      )
      const waiting = yield* Effect.forkDetach(
        Fiber.join(closing).pipe(
          Effect.timeoutOrElse({
            duration: HTTP_SHUTDOWN_GRACE,
            orElse: () => Effect.logInfo("http server did not stop within grace window — abandoning")
          })
        ),
        { startImmediately: true }
      )
      return yield* Fiber.join(waiting)
    })
  )
)

const secureIfPresent = Effect.fn("Server.secureIfPresent")((fs: FileSystem.FileSystem, path: string) =>
  Effect.flatMap(fs.exists(path), (present) => (present ? fs.chmod(path, 0o600) : Effect.void))
)

const coreLayer = (dbPath: string) => {
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
  const configurations = ConfigurationRepositoryLayer.pipe(Layer.provide(database))
  const automationCredentials = CredentialRepositoryLayer.pipe(Layer.provide(database))
  const executions = ExecutionRepositoryLayer.pipe(Layer.provide(Layer.mergeAll(database, configurations)))
  const httpOutbound = NodeHttpClient.layerFetch
  const registry = makeAutomationRegistry()
  const routines = RoutineServiceLayer(registry).pipe(Layer.provide(Layer.mergeAll(configurations, automationCredentials)))
  const worker = AutomationWorkerLayer(registry, {}).pipe(
    Layer.provide(Layer.mergeAll(executions, configurations, automationCredentials, routines, httpOutbound))
  )
  return Layer.mergeAll(projectUseCases, ServerUseCasesLayer, EventBusLayer, ConnectionTrackerLayer, projection, replay, configurations, automationCredentials, executions, routines, worker, httpOutbound)
}

const makeAutomationRegistry = (): AutomationRegistry<CredentialRepository | ConfigurationRepository | HttpClient.HttpClient> => {
  const registry = new AutomationRegistry<CredentialRepository | ConfigurationRepository | HttpClient.HttpClient>()
  Effect.runSync(registry.register(makeGithubServerExtension({}).extension))
  return registry
}
