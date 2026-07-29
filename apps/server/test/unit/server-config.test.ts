import { it } from "@effect/vitest"
import { Config, ConfigProvider, Effect, type LogLevel } from "effect"
import { describe, expect, expectTypeOf } from "vitest"
import { minimumLogLevel } from "@expand/server/server-config"

const configLayer = (value: unknown) =>
  ConfigProvider.layer(ConfigProvider.fromUnknown(value))

const loadMinimumLogLevel = (value: unknown): Effect.Effect<LogLevel.LogLevel> =>
  minimumLogLevel.pipe(
    Effect.provide(configLayer(value)),
    Effect.orDie
  )

describe("server config", () => {
  it.effect("preserves a valid configured log level", () =>
    Effect.forEach(["Debug", "None"] as const, (value) =>
      loadMinimumLogLevel({ EXPAND_LOG_LEVEL: value }).pipe(
        Effect.tap((level) => Effect.sync(() => {
          expect(level).toBe(value)
        }))
      )
    ))

  it.effect("uses Info when the log level is missing", () =>
    loadMinimumLogLevel({}).pipe(
      Effect.tap((level) => Effect.sync(() => {
        expect(level).toBe("Info")
      }))
    ))

  it.effect("uses Info when the log level is invalid", () =>
    loadMinimumLogLevel({ EXPAND_LOG_LEVEL: "Verbose" }).pipe(
      Effect.tap((level) => Effect.sync(() => {
        expect(level).toBe("Info")
      }))
    ))

  it("retains the exact Effect Config success type without a runner bridge", () => {
    expectTypeOf(minimumLogLevel).toEqualTypeOf<Config.Config<LogLevel.LogLevel>>()
    expectTypeOf(loadMinimumLogLevel({})).toEqualTypeOf<Effect.Effect<LogLevel.LogLevel>>()
  })
})
