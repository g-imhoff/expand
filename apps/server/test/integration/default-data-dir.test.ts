import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, Fiber, FileSystem, Option, Path, PlatformError, Schedule, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { describe, expect } from "vitest"

const childOutput = (
  stdout: Fiber.Fiber<string, PlatformError.PlatformError>,
  stderr: Fiber.Fiber<string, PlatformError.PlatformError>
) =>
  Effect.all([Fiber.join(stdout), Fiber.join(stderr)], { concurrency: "unbounded" })

type ServerChild = Effect.Success<ReturnType<typeof ChildProcess.make>>

const awaitChildReadiness = Effect.fn("DefaultDataDir.awaitChildReadiness")(function*(
  readiness: Effect.Effect<void, unknown>,
  child: ServerChild,
  stdout: Fiber.Fiber<string, PlatformError.PlatformError>,
  stderr: Fiber.Fiber<string, PlatformError.PlatformError>
) {
  yield* Effect.raceFirst(
    readiness,
    child.exitCode.pipe(
      Effect.flatMap((code) => childOutput(stdout, stderr).pipe(
        Effect.flatMap(([output, error]) => Effect.fail(
          Number(code) === 0
            ? `production server exited unexpectedly with code 0: stdout=${output} stderr=${error}`
            : `production server exited with nonzero code ${String(code)}: stdout=${output} stderr=${error}`
        ))
      ))
    )
  )
})

describe("default data directory", () => {
  it.live("surfaces an early failing child before readiness times out", () =>
    Effect.gen(function*() {
      const child = yield* ChildProcess.make(
        "node",
        ["--definitely-invalid-expand-option"],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe" }
      )
      const stdout = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString, Effect.forkScoped)
      const stderr = yield* child.stderr.pipe(Stream.decodeText(), Stream.mkString, Effect.forkScoped)
      const readiness = Effect.sleep("5 seconds").pipe(
        Effect.andThen(Effect.fail("readiness timed out" as const))
      )
      const error = yield* awaitChildReadiness(readiness, child, stdout, stderr).pipe(
        Effect.timeoutOrElse({
          duration: "1 second",
          orElse: () => Effect.fail("early exit was not surfaced" as const)
        }),
        Effect.flip
      )
      expect(error).toBe(
        "production server exited with nonzero code 9: stdout= stderr=node: bad option: --definitely-invalid-expand-option\n"
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

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
          stdout: "pipe",
          stderr: "pipe"
        }
      )
      const stdout = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString, Effect.forkScoped)
      const stderr = yield* child.stderr.pipe(Stream.decodeText(), Stream.mkString, Effect.forkScoped)
      const readiness = fs.exists(endpointFile).pipe(
        Effect.filterOrFail((exists) => exists, () => "pending" as const),
        Effect.retry(Schedule.spaced("25 millis")),
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () => Effect.fail("production server did not start" as const)
        }),
        Effect.asVoid
      )
      yield* awaitChildReadiness(readiness, child, stdout, stderr)
      const exit = yield* child.exitCode.pipe(Effect.timeoutOption("1 millis"))
      if (Option.isSome(exit)) {
        const [output, error] = yield* childOutput(stdout, stderr)
        return yield* Effect.fail(
          Number(exit.value) === 0
            ? `production server exited unexpectedly with code 0 after readiness: stdout=${output} stderr=${error}`
            : `production server exited with nonzero code ${String(exit.value)} after readiness: stdout=${output} stderr=${error}`
        )
      }
      expect(yield* fs.exists(path.join(legacyDir, "events.db"))).toBe(true)
      expect(yield* fs.exists(path.join(legacyDir, "marker"))).toBe(true)
      expect(yield* fs.exists(path.join(defaultDir, "events.db"))).toBe(true)
      expect(yield* fs.exists(path.join(defaultDir, "marker"))).toBe(false)
      expect(Option.isNone(exit), "production server must remain alive after readiness").toBe(true)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 15_000)
})
