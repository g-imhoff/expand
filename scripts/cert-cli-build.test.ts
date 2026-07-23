import * as NodePlatform from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Deferred, Effect, Fiber, FileSystem, Path } from "effect"
import { describe, expect, vi } from "vitest"
import { processSpawnerFixture } from "../test/support/process-spawner"
import { BuildError, BuildTool } from "./build"
import { CertificationError, certifyCliBuild } from "./cert-cli-build"

const fileSystem = FileSystem.layerNoop({
  remove: () => Effect.void,
  makeDirectory: () => Effect.void,
  chmod: () => Effect.void
})

describe("CLI build certification", () => {
  it.effect("proves both builds exit before smoke spawn in one ordered log", () => {
    const events: Array<string> = []
    const fixture = processSpawnerFixture([0], { eventLog: events })
    return certifyCliBuild("/repo").pipe(
      Effect.provideService(BuildTool, {
        build: (options) => Effect.sync(() => {
          events.push(`build:start:${String(options.outfile)}`)
          events.push(`build:exit:${String(options.outfile)}`)
        })
      }),
      Effect.provide(fileSystem),
      Effect.provide(Path.layer),
      Effect.provide(fixture.layer),
      Effect.tap(() => Effect.sync(() => {
        expect(events).toEqual([
          "build:start:/repo/dist/expand",
          "build:exit:/repo/dist/expand",
          "build:start:/repo/dist/expand-server",
          "build:exit:/repo/dist/expand-server",
          "spawn:bash",
          "exit:bash",
          "release:bash"
        ])
        expect(fixture.records).toHaveLength(1)
        const command = fixture.records[0]?.command
        expect(command?._tag).toBe("StandardCommand")
        if (command?._tag === "StandardCommand") {
          expect(command.command).toBe("bash")
          expect(command.args).toEqual(["scripts/binary-smoke.sh"])
          expect(command.options.cwd).toBe("/repo")
          expect(command.options.stdin).toBe("inherit")
          expect(command.options.stdout).toBe("inherit")
          expect(command.options.stderr).toBe("inherit")
        }
      }))
    )
  })

  it.effect("does not spawn smoke when a build fails", () => {
    const fixture = processSpawnerFixture([0])
    const failure = new Error("build failed")
    const events: Array<string> = []
    return certifyCliBuild("/repo").pipe(
      Effect.provideService(BuildTool, {
        build: () => Effect.sync(() => events.push("build:exit:failure")).pipe(Effect.andThen(Effect.fail(failure)))
      }),
      Effect.provide(fileSystem),
      Effect.provide(Path.layer),
      Effect.provide(fixture.layer),
      Effect.flip,
      Effect.tap((error) => Effect.sync(() => {
        expect(error).toEqual(new BuildError({ operation: "esbuild", cause: failure }))
        expect(events).toEqual(["build:exit:failure"])
        expect(fixture.records).toHaveLength(0)
      }))
    )
  })

  it.effect("releases an interrupted active build exactly once without spawning smoke", () =>
    Effect.gen(function*() {
      const fixture = processSpawnerFixture([0])
      const started = yield* Deferred.make<void>()
      const events: Array<string> = []
      const fiber = yield* certifyCliBuild("/repo").pipe(
        Effect.provideService(BuildTool, {
          build: () => Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Effect.sync(() => events.push("build:release")))
          )
        }),
        Effect.provide(fileSystem),
        Effect.provide(Path.layer),
        Effect.provide(fixture.layer),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred["a\u0077ait"](started)
      yield* Fiber.interrupt(fiber)
      expect(events).toEqual(["build:release"])
      expect(fixture.records).toHaveLength(0)
    }))

  it.effect("releases an interrupted active smoke process exactly once", () =>
    Effect.gen(function*() {
      const fixture = processSpawnerFixture([], { neverExitAt: 0 })
      const fiber = yield* certifyCliBuild("/repo").pipe(
        Effect.provideService(BuildTool, { build: () => Effect.void }),
        Effect.provide(fileSystem),
        Effect.provide(Path.layer),
        Effect.provide(fixture.layer),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.yieldNow
      expect(fixture.records).toHaveLength(1)
      yield* Fiber.interrupt(fiber)
      expect(fixture.records[0]?.releaseCount).toBe(1)
    }))

  it.effect("tags a nonzero smoke result", () => {
    const fixture = processSpawnerFixture([4])
    return certifyCliBuild("/repo").pipe(
      Effect.provideService(BuildTool, { build: () => Effect.void }),
      Effect.provide(fileSystem),
      Effect.provide(Path.layer),
      Effect.provide(fixture.layer),
      Effect.flip,
      Effect.tap((error) => Effect.sync(() => {
        expect(error).toEqual(new CertificationError({ exitCode: 4 }))
      }))
    )
  })

  it.effect("imports without running the CLI", () =>
    Effect.gen(function*() {
      vi.resetModules()
      const runMain = vi.fn()
      vi.doMock("@effect/platform-node", () => ({
        ...NodePlatform,
        NodeRuntime: { ...NodePlatform.NodeRuntime, runMain }
      }))
      const module = yield* Effect.promise(() => import("./cert-cli-build"))
      expect(module.certifyCliBuild).toBeTypeOf("function")
      expect(runMain).not.toHaveBeenCalled()
      vi.doUnmock("@effect/platform-node")
      vi.resetModules()
    }))
})
