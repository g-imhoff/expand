import * as NodePlatform from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Layer, Effect, FileSystem, Path } from "effect"
import { describe, expect, expectTypeOf, vi } from "vitest"
import { BuildTool, buildBinaries, type BuildError } from "./build"

const esbuildBuild = vi.hoisted(() => vi.fn())
vi.mock("esbuild", () => ({ build: esbuildBuild }))

const pathLayer = Path.layer

describe("buildBinaries", () => {
  it.effect("is lazy and builds deterministic entries before making them executable", () => {
    const operations: Array<string> = []
    const definitions: Array<unknown> = []
    const program = buildBinaries("/repo", "1.2.3")

    expect(Effect.isEffect(program)).toBe(true)
    expect(operations).toEqual([])

    return program.pipe(
      Effect.provideService(BuildTool, {
        build: (options) => Effect.sync(() => {
          const firstEntry = Array.isArray(options.entryPoints) ? options.entryPoints[0] : undefined
          operations.push(`build:${String(options.outfile)}:${typeof firstEntry === "string" ? firstEntry : ""}`)
          definitions.push(options.define)
        })
      }),
      Effect.provide(Layer.mergeAll(FileSystem.layerNoop({
        remove: (target) => Effect.sync(() => operations.push(`remove:${target}`)),
        makeDirectory: (target) => Effect.sync(() => operations.push(`mkdir:${target}`)),
        chmod: (target, mode) => Effect.sync(() => operations.push(`chmod:${target}:${mode.toString(8)}`))
      }), pathLayer)),
      Effect.tap(() => Effect.sync(() => {
        expect(operations).toEqual([
          "remove:/repo/dist",
          "mkdir:/repo/dist",
          "build:/repo/dist/expand:/repo/apps/cli/cli/main.ts",
          "chmod:/repo/dist/expand:755",
          "build:/repo/dist/expand-server:/repo/apps/server/main.ts",
          "chmod:/repo/dist/expand-server:755"
        ])
        expect(definitions).toEqual([
          { __EXPAND_CHANNEL__: '"release"', __EXPAND_VERSION__: '"1.2.3"' },
          { __EXPAND_CHANNEL__: '"release"', __EXPAND_VERSION__: '"1.2.3"' }
        ])
      }))
    )
  })

  it.effect("imports lazily and adapts the imported esbuild rejection to the exact tagged cause", () =>
    Effect.gen(function*() {
      vi.resetModules()
      const runMain = vi.fn()
      const cause = new Error("esbuild rejected")
      esbuildBuild.mockReset().mockRejectedValue(cause)
      vi.doMock("@effect/platform-node", () => ({
        ...NodePlatform,
        NodeRuntime: { ...NodePlatform.NodeRuntime, runMain }
      }))
      const module = yield* Effect.promise(() => import("./build"))
      expect(runMain).not.toHaveBeenCalled()
      expect(esbuildBuild).not.toHaveBeenCalled()

      let chmodCalls = 0
      const error = yield* module.buildBinaries("/repo", "1.2.3").pipe(
        Effect.provide(Layer.mergeAll(module.BuildToolLive, FileSystem.layerNoop({
          remove: () => Effect.void,
          makeDirectory: () => Effect.void,
          chmod: () => Effect.sync(() => {
            chmodCalls += 1
          })
        }), pathLayer)),
        Effect.flip
      )
      expect(error).toEqual(new module.BuildError({ operation: "esbuild", cause }))
      expect(esbuildBuild).toHaveBeenCalledTimes(1)
      expect(chmodCalls).toBe(0)
      vi.doUnmock("@effect/platform-node")
      vi.resetModules()
    }))

  it("exposes a typed Effect contract", () => {
    expectTypeOf(buildBinaries("/repo", "1.2.3")).toMatchTypeOf<
      Effect.Effect<void, BuildError, FileSystem.FileSystem | Path.Path | BuildTool>
    >()
  })
})
