import { Config, type LogLevel } from "effect"

export const minimumLogLevel = Config.logLevel("EXPAND_LOG_LEVEL").pipe(
  Config.orElse(() => Config.succeed<LogLevel.LogLevel>("Info"))
)
