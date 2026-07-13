import { NodeFileSystem, NodeRuntime, NodeServices } from "@effect/platform-node"
import { Cause, Effect, Exit, FileSystem, Layer, Logger, Path, References } from "effect"
import { NodeAppContext } from "@expand/server/node-app-context"
import { join } from "node:path"
import { AppContext } from "@expand/contracts/app-context"
import { runServer } from "@expand/server/composition/app"
import { stateRootLockForStartup } from "@expand/server/state-root-lock"

const LOG_LEVELS: ReadonlyArray<ServerLogLevel> = ["All", "Fatal", "Error", "Warn", "Info", "Debug", "Trace", "None"]

const minimumLogLevel = (): ServerLogLevel => {
  const raw = process.env.EXPAND_LOG_LEVEL
  return raw !== undefined && (LOG_LEVELS as ReadonlyArray<string>).includes(raw)
    ? (raw as ServerLogLevel)
    : "Info"
}

const fileLogger = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const { paths } = yield* AppContext
  yield* fs.makeDirectory(paths.logDir, { recursive: true })
  return yield* Logger.formatLogFmt.pipe(Logger.toFile(join(paths.logDir, "server.log")))
})

const loggerLayer = Logger.layer([fileLogger], { mergeWithExisting: true }).pipe(
  Layer.provide(NodeFileSystem.layer)
)

const loggedProgram = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const { paths } = yield* AppContext
  yield* fs.makeDirectory(path.dirname(paths.dbPath), { recursive: true })
  yield* runServer({ dbPath: paths.dbPath })
}).pipe(Effect.provide(loggerLayer))

const program = Effect.gen(function* () {
  const { paths } = yield* AppContext
  yield* stateRootLockForStartup(paths.dataDir, paths.endpointFile)
  yield* loggedProgram
}).pipe(Effect.scoped)

// Every file this process creates — the SQLite event store (+ WAL/SHM), the
// endpoint file that carries the auth token, the logs — is private to this
// user. Born-owner-only (0600 files, 0700 dirs) is the floor, so set a strict
// umask before the logger or anything else touches the filesystem.
process.umask(0o077)

NodeRuntime.runMain(
  program.pipe(
    Effect.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel())),
    Effect.provide(NodeAppContext.nodeAppContextLayer),
    Effect.tap(() => Effect.sync(() => process.exit(0))),
    Effect.provide(NodeServices.layer)
  ),
  {
    teardown: (exit, onExit) =>
      onExit(Exit.isSuccess(exit) || (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) ? 0 : 1)
  }
)

type ServerLogLevel = import("effect").LogLevel.LogLevel
