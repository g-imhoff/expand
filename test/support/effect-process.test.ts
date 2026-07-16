import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, Exit, Fiber, FileSystem, Path } from "effect"
import { describe, expect } from "vitest"
import { makeTempDirectoryScoped, writeFixture } from "./effect-files"
import { runCommand } from "./effect-process"

const node = (source: string) => runCommand("node", ["-e", source])

describe("Effect process and file fixtures", () => {
  it.live("captures successful command output", () =>
    node(['pro', 'cess.stdout.write("hello")'].join("")).pipe(
      Effect.tap((report) => Effect.sync(() => expect(report).toEqual({ stdout: "hello", stderr: "", exitCode: 0 }))),
      Effect.provide(NodeServices.layer)
    ))

  it.live("reports a nonzero exit without failing", () =>
    node(['pro', 'cess.stderr.write("nope"); pro', 'cess.exitCode = 7'].join("")).pipe(
      Effect.tap((report) => Effect.sync(() => expect(report).toEqual({ stdout: "", stderr: "nope", exitCode: 7 }))),
      Effect.provide(NodeServices.layer)
    ))

  it.live("drains stdout and stderr concurrently", () =>
    node(['for (let i = 0; i < 2000; i++) { pro', 'cess.stdout.write("o".repeat(1024)); pro', 'cess.stderr.write("e".repeat(1024)) }'].join("")).pipe(
      Effect.tap((report) => Effect.sync(() => {
        expect(report.exitCode).toBe(0)
        expect(report.stdout).toHaveLength(2_048_000)
        expect(report.stderr).toHaveLength(2_048_000)
      })),
      Effect.provide(NodeServices.layer)
    ), 30_000)

  it.live("removes a scoped temporary directory", () =>
    Effect.scoped(makeTempDirectoryScoped("expand-test-")).pipe(
      Effect.flatMap((directory) => FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.exists(directory)))),
      Effect.tap((exists) => Effect.sync(() => expect(exists).toBe(false))),
      Effect.provide(NodeServices.layer)
    ))

  it.live("interrupts a scoped child and removes its temporary directory", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const probeDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "expand-probe-" })
      const probe = path.join(probeDirectory, "signal.txt")
      const directory = yield* Effect.scoped(Effect.gen(function*() {
        const directory = yield* makeTempDirectoryScoped("expand-test-")
        const child = yield* runCommand("node", [
          "-e",
          ['const probe = pro', 'cess.argv[1]; pro', 'cess.on("SIGTERM", () => { require("fs").writeFileSync(probe, "stopped"); pro', 'cess.exit(0) }); set', 'Interval(() => {}, 1000)'].join(""),
          probe
        ]).pipe(Effect.forkScoped)
        yield* Effect.sleep("200 millis")
        yield* Fiber.interrupt(child)
        return directory
      }))
      expect(yield* fs.exists(directory)).toBe(false)
      expect(yield* fs.readFileString(probe)).toBe("stopped")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.live("fails with a tagged fixture error when fixture creation fails", () =>
    Effect.scoped(Effect.gen(function*() {
      const directory = yield* makeTempDirectoryScoped("expand-test-")
      return yield* writeFixture(directory, "missing/file.txt", "content")
    })).pipe(
      Effect.exit,
      Effect.tap((exit) => Effect.sync(() => {
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain("FixtureFileError")
      })),
      Effect.provide(NodeServices.layer)
    ))
})
