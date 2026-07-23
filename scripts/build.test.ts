import { it } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import { describe, expect, expectTypeOf } from "vitest"
import { BuildTool, buildBinaries, type BuildError } from "./build"

const pathLayer = Path.layer

describe("buildBinaries", () => {
  it.effect("is lazy and builds deterministic entries before making them executable", () => {
    const operations: Array<string> = []
    const program = buildBinaries("/repo")

    expect(Effect.isEffect(program)).toBe(true)
    expect(operations).toEqual([])

    return program.pipe(
      Effect.provideService(BuildTool, {
        build: (options) => Effect.sync(() => {
          const firstEntry = Array.isArray(options.entryPoints) ? options.entryPoints[0] : undefined
          operations.push(`build:${String(options.outfile)}:${typeof firstEntry === "string" ? firstEntry : ""}`)
        })
      }),
      Effect.provide(FileSystem.layerNoop({
        remove: (target) => Effect.sync(() => operations.push(`remove:${target}`)),
        makeDirectory: (target) => Effect.sync(() => operations.push(`mkdir:${target}`)),
        chmod: (target, mode) => Effect.sync(() => operations.push(`chmod:${target}:${mode.toString(8)}`))
      })),
      Effect.provide(pathLayer),
      Effect.tap(() => Effect.sync(() => {
        expect(operations).toEqual([
          "remove:/repo/dist",
          "mkdir:/repo/dist",
          "build:/repo/dist/expand:/repo/apps/cli/cli/main.ts",
          "chmod:/repo/dist/expand:755",
          "build:/repo/dist/expand-server:/repo/apps/server/main.ts",
          "chmod:/repo/dist/expand-server:755"
        ])
      }))
    )
  })

  it.effect("reports an esbuild rejection as a tagged error and skips chmod", () => {
    let chmodCalls = 0
    const cause = new Error("esbuild rejected")

    return buildBinaries("/repo").pipe(
      Effect.provideService(BuildTool, {
        build: () => Effect.fail(cause)
      }),
      Effect.provide(FileSystem.layerNoop({
        remove: () => Effect.void,
        makeDirectory: () => Effect.void,
        chmod: () => Effect.sync(() => {
          chmodCalls += 1
        })
      })),
      Effect.provide(pathLayer),
      Effect.flip,
      Effect.tap((error) => Effect.sync(() => {
        expect(error).toMatchObject({
          _tag: "BuildError",
          operation: "esbuild",
          cause
        })
        expect(chmodCalls).toBe(0)
      }))
    )
  })

  it("exposes a typed Effect contract", () => {
    expectTypeOf(buildBinaries("/repo")).toMatchTypeOf<
      Effect.Effect<void, BuildError, FileSystem.FileSystem | Path.Path | BuildTool>
    >()
  })
})
