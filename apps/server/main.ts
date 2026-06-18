import { BunFileSystem, BunRuntime, BunServices } from "@effect/platform-bun"
import { Cause, Effect, Exit, FileSystem, Layer, Logger, Path, References } from "effect"
import type { LogLevel } from "effect"
import { join } from "node:path"
import { appContextLayer, resolveAppContext } from "@yodea/contracts/app-context"
import { migrateLegacyHome } from "@yodea/server/migrate-legacy-home"
import { runServer } from "@yodea/server/composition/app"

const parseDataDir = (argv: ReadonlyArray<string>): string | undefined => {
  const i = argv.indexOf("--data-dir")
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined
}

const dataDirArg = parseDataDir(process.argv)
const ctx = resolveAppContext(dataDirArg)

const LOG_LEVELS: ReadonlyArray<LogLevel.LogLevel> = ["All", "Fatal", "Error", "Warn", "Info", "Debug", "Trace", "None"]

const minimumLogLevel = (): LogLevel.LogLevel => {
  const raw = process.env.YODEA_LOG_LEVEL
  return raw !== undefined && (LOG_LEVELS as ReadonlyArray<string>).includes(raw)
    ? (raw as LogLevel.LogLevel)
    : "Info"
}

const fileLogger = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  yield* fs.makeDirectory(ctx.paths.logDir, { recursive: true })
  return yield* Logger.formatLogFmt.pipe(Logger.toFile(join(ctx.paths.logDir, "server.log")))
})

const loggerLayer = Logger.layer([fileLogger], { mergeWithExisting: true }).pipe(
  Layer.provide(BunFileSystem.layer)
)

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* migrateLegacyHome(ctx.paths.dataDir)
  yield* fs.makeDirectory(path.dirname(ctx.paths.dbPath), { recursive: true })
  yield* runServer({ dbPath: ctx.paths.dbPath })
})

BunRuntime.runMain(
  program.pipe(
    Effect.provide(loggerLayer),
    Effect.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel())),
    Effect.provide(appContextLayer(dataDirArg)),
    Effect.provide(BunServices.layer),
    Effect.tap(() => Effect.sync(() => process.exit(0)))
  ),
  {
    teardown: (exit, onExit) =>
      onExit(Exit.isSuccess(exit) || (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) ? 0 : 1)
  }
)
