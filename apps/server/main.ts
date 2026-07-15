import { NodeFileSystem, NodeRuntime, NodeServices } from "@effect/platform-node"
import { Cause, Effect, Exit, FileSystem, Layer, Logger, Path, References } from "effect"
import { nodeAppContextLayer } from "@expand/server/node-app-context"
import { minimumLogLevel } from "@expand/server/server-config"
import * as AppContext from "@expand/contracts/app-context"
import * as ServerApp from "@expand/server/composition/app"
import * as StateRootLock from "@expand/server/state-root-lock"
import * as NodeProcessControl from "@expand/server/node-process-control"

const fileLogger = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const { paths } = yield* AppContext.AppContext
  yield* fs.makeDirectory(paths.logDir, { recursive: true })
  return yield* Logger.formatLogFmt.pipe(Logger.toFile(path.join(paths.logDir, "server.log")))
})

const loggerLayer = Logger.layer([fileLogger], { mergeWithExisting: true }).pipe(
  Layer.provide(NodeFileSystem.layer)
)

const loggedProgram = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const { paths } = yield* AppContext.AppContext
  yield* fs.makeDirectory(path.dirname(paths.dbPath), { recursive: true })
  yield* ServerApp.runServer({ dbPath: paths.dbPath })
}).pipe(Effect.provide(loggerLayer))

const program = Effect.gen(function* () {
  const { paths } = yield* AppContext.AppContext
  yield* StateRootLock.stateRootLockForStartup(paths.dataDir, paths.endpointFile)
  yield* loggedProgram
}).pipe(Effect.scoped)

// Every file this process creates — the SQLite event store (+ WAL/SHM), the
// endpoint file that carries the auth token, the logs — is private to this
// user. Born-owner-only (0600 files, 0700 dirs) is the floor, so set a strict
// umask before the logger or anything else touches the filesystem.
process.umask(0o077)

NodeRuntime.runMain(
  program.pipe(
    Effect.provideServiceEffect(References.MinimumLogLevel, minimumLogLevel),
    Effect.provide(nodeAppContextLayer),
    Effect.provide(
      NodeProcessControl.ProcessServices.layer satisfies Layer.Layer<
        NodeServices.NodeServices | import("@expand/contracts/process-control").ProcessControl
      >
    )
  ),
  {
    teardown: (exit, onExit) =>
      onExit(Exit.isSuccess(exit) || (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) ? 0 : 1)
  }
)
