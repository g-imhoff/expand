import { it } from "@effect/vitest"
import { Layer, ConfigProvider, Effect, FileSystem, PlatformError } from "effect"
import { describe, expect, expectTypeOf } from "vitest"
import {
  resolveBackendCommand,
  type BackendCommandError,
  type ResolveBackendCommandOptions
} from "../../index"

const configLayer = (value: unknown = {}) =>
  ConfigProvider.layer(ConfigProvider.fromUnknown(value))

const fileSystemLayer = (exists: FileSystem.FileSystem["exists"]) =>
  FileSystem.layerNoop({ exists })

describe("resolveBackendCommand", () => {
  it.effect("uses a non-empty override before source and compiled commands", () => {
    let fileSystemReads = 0
    return resolveBackendCommand({
      execPath: "node",
      sourceEntry: "/source/server.ts",
      binaryArgs: ["compiled"]
    }).pipe(
      Effect.provide(Layer.mergeAll(configLayer({ EXPAND_BACKEND_CMD: '["my-server","--flag"]' }), fileSystemLayer(() => Effect.sync(() => {
        fileSystemReads += 1
        return true
      })))),
      Effect.tap((command) => Effect.sync(() => {
        expect(command).toEqual(["my-server", "--flag"])
        expect(fileSystemReads).toBe(0)
      }))
    )
  })

  it.effect("reports malformed JSON in the typed error channel", () =>
    resolveBackendCommand({ execPath: "node", binaryArgs: ["fallback"] }).pipe(
      Effect.provide(Layer.mergeAll(configLayer({ EXPAND_BACKEND_CMD: "{" }), fileSystemLayer(() => Effect.succeed(false)))),
      Effect.flip,
      Effect.tap((error) => Effect.sync(() => {
        expect(error._tag).toBe("BackendCommandError")
        expect(error.reason).toBe("invalid-override")
      }))
    ))

  it.effect("reports non-string override arrays in the typed error channel", () =>
    Effect.forEach(['["ok",3]', '{"cmd":"x"}'], (override) =>
      resolveBackendCommand({ binaryArgs: ["fallback"] }).pipe(
        Effect.provide(Layer.mergeAll(configLayer({ EXPAND_BACKEND_CMD: override }), fileSystemLayer(() => Effect.succeed(false)))),
        Effect.flip
      )
    ).pipe(
      Effect.tap((errors) => Effect.sync(() => {
        expect(errors.map((error) => error.reason)).toEqual(["invalid-override", "invalid-override"])
      }))
    ))

  it.effect("reports an empty override array in the typed error channel", () =>
    resolveBackendCommand({ binaryArgs: ["fallback"] }).pipe(
      Effect.provide(Layer.mergeAll(configLayer({ EXPAND_BACKEND_CMD: "[]" }), fileSystemLayer(() => Effect.succeed(false)))),
      Effect.flip,
      Effect.tap((error) => Effect.sync(() => {
        expect(error.reason).toBe("invalid-override")
      }))
    ))

  it.effect("ignores an empty override string", () =>
    resolveBackendCommand({ binaryArgs: ["fallback"] }).pipe(
      Effect.provide(Layer.mergeAll(configLayer({ EXPAND_BACKEND_CMD: "" }), fileSystemLayer(() => Effect.succeed(false)))),
      Effect.tap((command) => Effect.sync(() => {
        expect(command).toEqual(["fallback"])
      }))
    ))

  it.effect("uses source mode when the source entry exists", () =>
    resolveBackendCommand({
      execPath: "node",
      runtimeArgs: ["--import", "tsx"],
      sourceEntry: "/source/server.ts",
      sourceArgs: ["server"],
      binaryArgs: ["compiled"]
    }).pipe(
      Effect.provide(Layer.mergeAll(configLayer(), fileSystemLayer((path) => Effect.succeed(path === "/source/server.ts")))),
      Effect.tap((command) => Effect.sync(() => {
        expect(command).toEqual(["node", "--import", "tsx", "/source/server.ts", "server"])
      }))
    ))

  it.effect("uses the compiled fallback when the source entry is missing", () =>
    resolveBackendCommand({
      execPath: "node",
      sourceEntry: "/source/missing.ts",
      binaryArgs: ["expand-server"]
    }).pipe(
      Effect.provide(Layer.mergeAll(configLayer(), fileSystemLayer(() => Effect.succeed(false)))),
      Effect.tap((command) => Effect.sync(() => {
        expect(command).toEqual(["expand-server"])
      }))
    ))

  it.effect("uses the compiled fallback without consulting the filesystem when source mode is absent", () => {
    let fileSystemReads = 0
    return resolveBackendCommand({ binaryArgs: ["node", "/compiled/server.js"] }).pipe(
      Effect.provide(Layer.mergeAll(configLayer(), fileSystemLayer(() => Effect.sync(() => {
        fileSystemReads += 1
        return false
      })))),
      Effect.tap((command) => Effect.sync(() => {
        expect(command).toEqual(["node", "/compiled/server.js"])
        expect(fileSystemReads).toBe(0)
      }))
    )
  })

  it.effect("reports filesystem failures in the typed error channel", () => {
    const cause = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "exists",
      pathOrDescriptor: "/source/server.ts"
    })
    return resolveBackendCommand({ execPath: "node", sourceEntry: "/source/server.ts" }).pipe(
      Effect.provide(Layer.mergeAll(configLayer(), fileSystemLayer(() => Effect.fail(cause)))),
      Effect.flip,
      Effect.tap((error) => Effect.sync(() => {
        expect(error.reason).toBe("source-check-failed")
        expect(error.cause).toBe(cause)
      }))
    )
  })

  it.effect("reports an absent command in the typed error channel", () =>
    resolveBackendCommand({}).pipe(
      Effect.provide(Layer.mergeAll(configLayer(), fileSystemLayer(() => Effect.succeed(false)))),
      Effect.flip,
      Effect.tap((error) => Effect.sync(() => {
        expect(error).toMatchObject({
          _tag: "BackendCommandError",
          reason: "not-configured",
          detail: "no backend command configured"
        })
      }))
    ))

  it("requires an explicit execPath for source-mode options", () => {
    expectTypeOf<{ readonly sourceEntry: string }>().not.toMatchTypeOf<ResolveBackendCommandOptions>()
    expectTypeOf<{
      readonly sourceEntry: string
      readonly execPath: string
    }>().toMatchTypeOf<ResolveBackendCommandOptions>()
  })

  it("exposes the resolver's Effect contract", () => {
    expectTypeOf(resolveBackendCommand({ binaryArgs: ["expand-server"] })).toMatchTypeOf<
      Effect.Effect<ReadonlyArray<string>, BackendCommandError, FileSystem.FileSystem>
    >()
  })
})
