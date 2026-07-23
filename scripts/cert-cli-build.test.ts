import * as NodePlatform from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import { describe, expect, vi } from "vitest"
import { processSpawnerFixture } from "../test/support/process-spawner"
import { BuildTool } from "./build"
import { CertificationError, certifyCliBuild } from "./cert-cli-build"

const fileSystem = FileSystem.layerNoop({
  remove: () => Effect.void,
  makeDirectory: () => Effect.void,
  chmod: () => Effect.void
})

describe("CLI build certification", () => {
  it.effect("builds both binaries before running the scoped smoke harness", () => {
    const fixture = processSpawnerFixture([0])
    const operations: Array<string> = []
    return certifyCliBuild("/repo").pipe(
      Effect.provideService(BuildTool, {
        build: (options) => Effect.sync(() => operations.push(`build:${String(options.outfile)}`))
      }),
      Effect.provide(fileSystem),
      Effect.provide(Path.layer),
      Effect.provide(fixture.layer),
      Effect.tap(() => Effect.sync(() => {
        expect(operations).toEqual(["build:/repo/dist/expand", "build:/repo/dist/expand-server"])
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
