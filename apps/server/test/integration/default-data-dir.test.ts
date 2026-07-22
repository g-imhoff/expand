import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Option, Path, Schedule, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { describe, expect } from "vitest"

describe("default data directory", () => {
  it.live("starts fresh without moving an old unscoped home", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "expand-default-isolation-" })
      const legacyDir = path.join(root, ".expand")
      const defaultDir = path.join(legacyDir, "expand-dev")
      const endpointFile = path.join(defaultDir, "server.json")
      yield* fs.makeDirectory(legacyDir)
      yield* fs.writeFileString(path.join(legacyDir, "events.db"), "")
      yield* fs.writeFileString(path.join(legacyDir, "marker"), "legacy")

      const child = yield* ChildProcess.make(
        "node",
        ["--import", "tsx", "apps/server/main.ts"],
        {
          cwd: path.resolve("."),
          env: { HOME: root, EXPAND_LOG_LEVEL: "None" },
          extendEnv: true,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe"
        }
      )
      yield* child.stderr.pipe(Stream.decodeText(), Stream.mkString, Effect.forkScoped)
      yield* fs.exists(endpointFile).pipe(
        Effect.filterOrFail((exists) => exists, () => "pending" as const),
        Effect.retry(Schedule.spaced("25 millis")),
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () => Effect.fail("production server did not start" as const)
        })
      )
      const exit = child.exitCode.pipe(Effect.timeoutOption("1 millis"))
      expect(yield* fs.exists(path.join(legacyDir, "events.db"))).toBe(true)
      expect(yield* fs.exists(path.join(legacyDir, "marker"))).toBe(true)
      expect(yield* fs.exists(path.join(defaultDir, "events.db"))).toBe(true)
      expect(yield* fs.exists(path.join(defaultDir, "marker"))).toBe(false)
      expect(Option.isNone(yield* exit)).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 15_000)
})
