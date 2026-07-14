import { Config, Effect, FileSystem, Option, Schema } from "effect"
import { BackendCommandError } from "./errors"

export type ResolveBackendCommandOptions = SourceBackendCommandOptions | NonSourceBackendCommandOptions

export const resolveBackendCommand = (() => {
  const sourceEntryPattern = /\.(ts|js|mjs|cjs)$/
  const backendCommandOverride = Schema.fromJsonString(
    Schema.Array(Schema.String).check(Schema.isNonEmpty())
  )

  return Effect.fn("BackendCommand.resolve")(function*(options: ResolveBackendCommandOptions) {
    const fs = yield* FileSystem.FileSystem
    const override = yield* Config.option(Config.string("EXPAND_BACKEND_CMD")).pipe(
      Effect.mapError((cause) => new BackendCommandError({
        reason: "invalid-override",
        detail: cause.message,
        cause
      }))
    )
    if (Option.isSome(override) && override.value !== "") {
      return yield* Schema.decodeUnknownEffect(backendCommandOverride)(override.value).pipe(
        Effect.mapError((cause) => new BackendCommandError({
          reason: "invalid-override",
          detail: cause.message,
          cause
        }))
      )
    }
    if (options.sourceEntry !== undefined && sourceEntryPattern.test(options.sourceEntry)) {
      const exists = yield* fs.exists(options.sourceEntry).pipe(
        Effect.mapError((cause) => new BackendCommandError({
          reason: "source-check-failed",
          detail: String(cause),
          cause
        }))
      )
      if (exists) {
        return [
          options.execPath,
          ...(options.runtimeArgs ?? []),
          options.sourceEntry,
          ...(options.sourceArgs ?? [])
        ]
      }
    }
    if (options.binaryArgs !== undefined && options.binaryArgs.length > 0) {
      return options.binaryArgs
    }
    return yield* Effect.fail(new BackendCommandError({
      reason: "not-configured",
      detail: "no backend command configured"
    }))
  })
})()

interface BackendCommandOptions {
  readonly runtimeArgs?: ReadonlyArray<string>
  readonly sourceArgs?: ReadonlyArray<string>
  readonly binaryArgs?: ReadonlyArray<string>
}

interface SourceBackendCommandOptions extends BackendCommandOptions {
  readonly sourceEntry: string
  readonly execPath: string
}

interface NonSourceBackendCommandOptions extends BackendCommandOptions {
  readonly sourceEntry?: undefined
  readonly execPath?: string
}
