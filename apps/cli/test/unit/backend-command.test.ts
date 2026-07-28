import { it } from "@effect/vitest"
import { Layer, ConfigProvider, Effect, FileSystem } from "effect"
import { describe, expect, expectTypeOf } from "vitest"
import { type BackendCommandError } from "@expand/client-ts"
import { backendCommand } from "@expand/cli/main"

const moduleUrl = new URL("file:///tmp/Expand%20Workspace/%E2%9C%A8/apps/cli/cli/main.ts")
const sourceEntry = "/tmp/Expand Workspace/✨/apps/server/main.ts"
const compiledEntry = "/tmp/Expand Workspace/✨/apps/cli/cli/expand-server"

const configLayer = (value: unknown = {}) =>
  ConfigProvider.layer(ConfigProvider.fromUnknown(value))

const fileSystemLayer = (exists: FileSystem.FileSystem["exists"]) =>
  FileSystem.layerNoop({ exists })

describe("backendCommand", () => {
  it.effect("decodes the module URL and selects the source command", () => {
    const paths: Array<string> = []
    return backendCommand(moduleUrl).pipe(
      Effect.provide(Layer.mergeAll(configLayer(), fileSystemLayer((path) => Effect.sync(() => {
        paths.push(path)
        return true
      })))),
      Effect.tap((command) => Effect.sync(() => {
        expect(paths).toEqual([sourceEntry])
        expect(command).toEqual([expect.any(String), "--import", "tsx", sourceEntry])
      }))
    )
  })

  it.effect("decodes the module URL and selects the adjacent compiled command", () =>
    backendCommand(moduleUrl).pipe(
      Effect.provide(Layer.mergeAll(configLayer(), fileSystemLayer(() => Effect.succeed(false)))),
      Effect.tap((command) => Effect.sync(() => {
        expect(command).toEqual([expect.any(String), compiledEntry])
      }))
    ))

  it.effect("uses a non-empty override without reading the filesystem", () => {
    let fileSystemReads = 0
    return backendCommand(moduleUrl).pipe(
      Effect.provide(Layer.mergeAll(configLayer({ EXPAND_BACKEND_CMD: '["custom-server","--flag","snow-雪"]' }), fileSystemLayer(() => Effect.sync(() => {
        fileSystemReads += 1
        return true
      })))),
      Effect.tap((command) => Effect.sync(() => {
        expect(command).toEqual(["custom-server", "--flag", "snow-雪"])
        expect(fileSystemReads).toBe(0)
      }))
    )
  })

  it.effect("does not read the filesystem until the command Effect executes", () => {
    let fileSystemReads = 0
    const command = backendCommand(moduleUrl)
    expect(fileSystemReads).toBe(0)
    return command.pipe(
      Effect.provide(Layer.mergeAll(configLayer(), fileSystemLayer(() => Effect.sync(() => {
        fileSystemReads += 1
        return true
      })))),
      Effect.tap(() => Effect.sync(() => {
        expect(fileSystemReads).toBe(1)
      }))
    )
  })

  it("exposes only the filesystem-backed typed command contract", () => {
    expectTypeOf(backendCommand(moduleUrl)).toEqualTypeOf<
      Effect.Effect<ReadonlyArray<string>, BackendCommandError, FileSystem.FileSystem>
    >()
  })
})
