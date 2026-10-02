import { Config, type LogLevel } from "effect"

export const minimumLogLevel = Config.LogLevel("EXPAND_LOG_LEVEL").pipe(
  Config.orElse(() => Config.succeed<LogLevel.LogLevel>("Info"))
)
