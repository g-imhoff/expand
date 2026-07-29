import * as NodePlatform from "@effect/platform-node"
import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Cause, Console, Effect, Exit, Fiber, FileSystem, Layer, Path, PlatformError } from "effect"
import { describe, expect, vi } from "vitest"
import { processSpawnerFixture } from "../../../test/support/process-spawner"
import { ArchitectureBuildError, ArchitectureFileError, NoD2SourcesError, buildArchitecture, enumerateD2Sources } from "./build"

const live = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(
  Effect.scoped,
  Effect.provide(NodeServices.layer)
)

const capturingConsole = (lines: Array<string>): Console.Console => ({
  log: (...args: ReadonlyArray<unknown>) => { lines.push(args.join(" ")) },
  error: () => undefined
} as unknown as Console.Console)

describe("architecture docs build", () => {
  it.live("enumerates only D2 files in deterministic order", () =>
    live(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "expand-docs-build-" })
      yield* fs.makeDirectory(path.join(root, "d2"))
      yield* fs.writeFileString(path.join(root, "d2", "z.d2"), "z")
      yield* fs.writeFileString(path.join(root, "d2", "a.d2"), "a")
      yield* fs.writeFileString(path.join(root, "d2", "ignore.txt"), "x")

      expect(yield* enumerateD2Sources(root)).toEqual([
        path.join(root, "d2", "a.d2"),
        path.join(root, "d2", "z.d2")
      ])
    })))

  it.live("fails with a typed zero-D2 error and cleans all generated directories", () => {
    const fixture = processSpawnerFixture([0, 0])
    return live(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "expand-docs-zero-" })
      const error = yield* buildArchitecture(root).pipe(Effect.provide(fixture.layer), Effect.flip)

      expect(error).toBeInstanceOf(NoD2SourcesError)
      expect(yield* fs.exists(path.join(root, "out"))).toBe(false)
      expect(yield* fs.exists(path.join(root, "out-svg"))).toBe(false)
      expect(yield* fs.exists(path.join(root, "d2"))).toBe(false)
    }))
  })

  it.effect("preserves the primary build failure together with cleanup failure", () => {
    const fixture = processSpawnerFixture([0, 0])
    const permission = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "remove",
      pathOrDescriptor: "/repo/docs/architecture/out"
    })
    let removals = 0
    return buildArchitecture("/repo/docs/architecture").pipe(
      Effect.provide(Layer.mergeAll(fixture.layer, FileSystem.layerNoop({
        remove: () => {
          removals += 1
          return removals > 3 ? Effect.fail(permission) : Effect.void
        },
        readDirectory: () => Effect.succeed([]),
        makeDirectory: () => Effect.void
      }), Path.layer)),
      Effect.provideService(Console.Console, capturingConsole([])),
      Effect.exit,
      Effect.tap((exit) => Effect.sync(() => {
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const failures = exit.cause.reasons.filter(Cause.isFailReason).map(({ error }) => error)
          expect(failures.some((error) => error instanceof NoD2SourcesError)).toBe(true)
          expect(failures.some((error) => error instanceof ArchitectureFileError)).toBe(true)
        }
      }))
    )
  })

  it.effect("cleans first, runs LikeC4, renders sorted D2 files with bounded concurrency, and logs output", () => {
    const fixture = processSpawnerFixture([0, 0, 0, 0])
    const operations: Array<string> = []
    const lines: Array<string> = []
    return buildArchitecture("/repo/docs/architecture").pipe(
      Effect.provide(Layer.mergeAll(fixture.layer, FileSystem.layerNoop({
        remove: (target) => Effect.sync(() => operations.push(`remove:${target}`)),
        readDirectory: () => Effect.succeed(["z.d2", "ignore.txt", "a.d2"]),
        makeDirectory: (target) => Effect.sync(() => operations.push(`mkdir:${target}`))
      }), Path.layer)),
      Effect.provideService(Console.Console, capturingConsole(lines)),
      Effect.tap(() => Effect.sync(() => {
        expect(operations.slice(0, 3)).toEqual([
          "remove:/repo/docs/architecture/out",
          "remove:/repo/docs/architecture/out-svg",
          "remove:/repo/docs/architecture/d2"
        ])
        const commands = fixture.records.map(({ command }) => command._tag === "StandardCommand"
          ? { command: command.command, args: command.args, cwd: command.options.cwd }
          : undefined)
        expect(commands).toEqual([
          { command: "likec4", args: ["export", "png", "-o", "./out"], cwd: "/repo/docs/architecture" },
          { command: "likec4", args: ["gen", "d2", "-o", "./d2"], cwd: "/repo/docs/architecture" },
          { command: "d2", args: ["--layout", "elk", "--theme", "300", "/repo/docs/architecture/d2/a.d2", "/repo/docs/architecture/out-svg/a.svg"], cwd: "/repo/docs/architecture" },
          { command: "d2", args: ["--layout", "elk", "--theme", "300", "/repo/docs/architecture/d2/z.d2", "/repo/docs/architecture/out-svg/z.svg"], cwd: "/repo/docs/architecture" }
        ])
        expect(lines).toEqual([
          "→ rendering PNG via likec4 (Playwright)",
          "→ generating D2 sources + rendering SVG",
          "✓ built png in ./out and svg in ./out-svg"
        ])
      }))
    )
  })

  it.effect("cancels sibling rendering and cleans outputs after one D2 renderer fails", () => {
    const fixture = processSpawnerFixture([0, 0, 0, 8], { neverExitAt: 2 })
    const removals: Array<string> = []
    return buildArchitecture("/repo/docs/architecture").pipe(
      Effect.provide(Layer.mergeAll(fixture.layer, FileSystem.layerNoop({
        remove: (target) => Effect.sync(() => removals.push(target)),
        readDirectory: () => Effect.succeed(["a.d2", "b.d2"]),
        makeDirectory: () => Effect.void
      }), Path.layer)),
      Effect.provideService(Console.Console, capturingConsole([])),
      Effect.flip,
      Effect.tap((error) => Effect.sync(() => {
        expect(error).toEqual(new ArchitectureBuildError({ command: "d2", exitCode: 8 }))
        expect(fixture.records).toHaveLength(4)
        expect(fixture.records[2]?.released).toBe(true)
        expect(removals.filter((target) => target.endsWith("/out"))).toHaveLength(2)
        expect(removals.filter((target) => target.endsWith("/out-svg"))).toHaveLength(2)
        expect(removals.filter((target) => target.endsWith("/d2"))).toHaveLength(2)
      }))
    )
  })

  it.effect("releases the active child and cleans outputs when interrupted", () => {
    const fixture = processSpawnerFixture([], { neverExitAt: 0 })
    const removals: Array<string> = []
    return Effect.gen(function*() {
      const fiber = yield* buildArchitecture("/repo/docs/architecture").pipe(
        Effect.provide(Layer.mergeAll(fixture.layer, FileSystem.layerNoop({
          remove: (target) => Effect.sync(() => removals.push(target)),
          makeDirectory: () => Effect.void
        }), Path.layer)),
        Effect.provideService(Console.Console, capturingConsole([])),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.forEach([0, 1, 2, 3, 4, 5, 6, 7], () => Effect.yieldNow, { discard: true })
      expect(fixture.records).toHaveLength(1)

      yield* Fiber.interrupt(fiber)

      expect(fixture.records[0]?.released).toBe(true)
      expect(removals.filter((target) => target.endsWith("/out"))).toHaveLength(2)
      expect(removals.filter((target) => target.endsWith("/out-svg"))).toHaveLength(2)
      expect(removals.filter((target) => target.endsWith("/d2"))).toHaveLength(2)
    })
  })

  it.effect("imports without running the CLI", () =>
    Effect.gen(function*() {
      vi.resetModules()
      const runMain = vi.fn()
      vi.doMock("@effect/platform-node", () => ({
        ...NodePlatform,
        NodeRuntime: { ...NodePlatform.NodeRuntime, runMain }
      }))
      const module = yield* Effect.promise(() => import("./build"))
      expect(module.buildArchitecture).toBeTypeOf("function")
      expect(runMain).not.toHaveBeenCalled()
      vi.doUnmock("@effect/platform-node")
      vi.resetModules()
    }))
})
