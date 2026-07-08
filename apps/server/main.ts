import { BunFileSystem, BunRuntime, BunServices } from "@effect/platform-bun"
import { Cause, Effect, Exit, FileSystem, Layer, Logger, Path, References } from "effect"
import type { LogLevel } from "effect"
import { join } from "node:path"
import { AppContext } from "@expand/contracts/app-context"
import { migrateLegacyHome } from "@expand/server/migrate-legacy-home"
import { runServer } from "@expand/server/composition/app"

const LOG_LEVELS: ReadonlyArray<LogLevel.LogLevel> = ["All", "Fatal", "Error", "Warn", "Info", "Debug", "Trace", "None"]

const minimumLogLevel = (): LogLevel.LogLevel => {
  const raw = process.env.EXPAND_LOG_LEVEL
  return raw !== undefined && (LOG_LEVELS as ReadonlyArray<string>).includes(raw)
    ? (raw as LogLevel.LogLevel)
    : "Info"
}

// The file logger resolves its own logDir from the AppContext reference (which
// always resolves to its default), so the log dir is known before the runtime
// starts and nothing has to provide AppContext.
const fileLogger = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const { paths } = yield* AppContext
  yield* fs.makeDirectory(paths.logDir, { recursive: true })
  return yield* Logger.formatLogFmt.pipe(Logger.toFile(join(paths.logDir, "server.log")))
})

const loggerLayer = Logger.layer([fileLogger], { mergeWithExisting: true }).pipe(
  Layer.provide(BunFileSystem.layer)
)

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const { paths } = yield* AppContext
  yield* migrateLegacyHome(paths.dataDir)
  yield* fs.makeDirectory(path.dirname(paths.dbPath), { recursive: true })
  yield* runServer({ dbPath: paths.dbPath })
})

BunRuntime.runMain(
  program.pipe(
    Effect.provide(loggerLayer),
    Effect.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel())),
    Effect.provide(BunServices.layer),
    Effect.tap(() => Effect.sync(() => process.exit(0)))
  ),
  {
    teardown: (exit, onExit) =>
      onExit(Exit.isSuccess(exit) || (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) ? 0 : 1)
  }
)
