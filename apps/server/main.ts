import { BunFileSystem, BunRuntime, BunServices } from "@effect/platform-bun"
import { Cause, Effect, Exit, FileSystem, Layer, Logger, Path, References } from "effect"
import type { LogLevel } from "effect"
import { join } from "node:path"
import { yodeaHomeDir } from "@yodea/contracts/endpoint"
import { runServer } from "@yodea/server/composition/app"

const dbPath = (): string => process.env.YODEA_DB ?? join(yodeaHomeDir(), "events.db")

const LOG_LEVELS: ReadonlyArray<LogLevel.LogLevel> = ["All", "Fatal", "Error", "Warn", "Info", "Debug", "Trace", "None"]

const minimumLogLevel = (): LogLevel.LogLevel => {
  const raw = process.env.YODEA_LOG_LEVEL
  return raw !== undefined && (LOG_LEVELS as ReadonlyArray<string>).includes(raw)
    ? (raw as LogLevel.LogLevel)
    : "Info"
}

const fileLogger = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const logsDir = join(yodeaHomeDir(), "logs")
  yield* fs.makeDirectory(logsDir, { recursive: true })
  return yield* Logger.formatLogFmt.pipe(Logger.toFile(join(logsDir, "server.log")))
})

const loggerLayer = Logger.layer([fileLogger], { mergeWithExisting: true }).pipe(
  Layer.provide(BunFileSystem.layer)
)

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const db = dbPath()
  yield* fs.makeDirectory(path.dirname(db), { recursive: true })
  yield* runServer({ dbPath: db })
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
