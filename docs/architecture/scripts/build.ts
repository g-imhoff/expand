import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Cause, Console, Data, Effect, Exit, FileSystem, Path } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

export class ArchitectureBuildError extends Data.TaggedError("ArchitectureBuildError")<{
  readonly command: string
  readonly exitCode: number
}> {}

export class ArchitectureProcessError extends Data.TaggedError("ArchitectureProcessError")<{
  readonly command: string
  readonly cause: unknown
}> {}

export class ArchitectureFileError extends Data.TaggedError("ArchitectureFileError")<{
  readonly operation: "clean" | "mkdir" | "enumerate"
  readonly path: string
  readonly cause: unknown
}> {}

export class NoD2SourcesError extends Data.TaggedError("NoD2SourcesError")<{
  readonly directory: string
}> {}

const runCommand = Effect.fn("ArchitectureBuild.runCommand")(
  (cwd: string, command: string, args: ReadonlyArray<string>) =>
    Effect.scoped(Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const handle = yield* spawner.spawn(ChildProcess.make(command, args, {
        cwd,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit"
      })).pipe(Effect.mapError((cause) => new ArchitectureProcessError({ command, cause })))
      const exitCode = yield* handle.exitCode.pipe(
        Effect.mapError((cause) => new ArchitectureProcessError({ command, cause }))
      )
      if (exitCode !== 0) {
        return yield* new ArchitectureBuildError({ command, exitCode })
      }
    }))
)

const cleanOutputs = Effect.fn("ArchitectureBuild.cleanOutputs")(
  function*(root: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    for (const directory of ["out", "out-svg", "d2"]) {
      const target = path.join(root, directory)
      yield* fs.remove(target, { recursive: true, force: true }).pipe(
        Effect.mapError((cause) => new ArchitectureFileError({ operation: "clean", path: target, cause }))
      )
    }
  }
)

export const enumerateD2Sources = Effect.fn("ArchitectureBuild.enumerateD2Sources")(
  function*(root: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const directory = path.join(root, "d2")
    const entries = yield* fs.readDirectory(directory).pipe(
      Effect.mapError((cause) => new ArchitectureFileError({ operation: "enumerate", path: directory, cause }))
    )
    return entries
      .filter((entry) => entry.endsWith(".d2"))
      .sort((left, right) => left.localeCompare(right))
      .map((entry) => path.join(directory, entry))
  }
)

export const buildArchitecture = Effect.fn("ArchitectureBuild.build")(
  function*(root: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const d2Directory = path.join(root, "d2")
    const svgDirectory = path.join(root, "out-svg")

    const workflow = Effect.gen(function*() {
      yield* cleanOutputs(root)
      yield* fs.makeDirectory(d2Directory, { recursive: true }).pipe(
        Effect.mapError((cause) => new ArchitectureFileError({ operation: "mkdir", path: d2Directory, cause }))
      )
      yield* Console.log("→ rendering PNG via likec4 (Playwright)")
      yield* runCommand(root, "likec4", ["export", "png", "-o", "./out"])
      yield* Console.log("→ generating D2 sources + rendering SVG")
      yield* runCommand(root, "likec4", ["gen", "d2", "-o", "./d2"])
      const sources = yield* enumerateD2Sources(root)
      if (sources.length === 0) {
        return yield* new NoD2SourcesError({ directory: d2Directory })
      }
      yield* fs.makeDirectory(svgDirectory, { recursive: true }).pipe(
        Effect.mapError((cause) => new ArchitectureFileError({ operation: "mkdir", path: svgDirectory, cause }))
      )
      yield* Effect.forEach(sources, (source) => {
        const name = path.basename(source, ".d2")
        return runCommand(root, "d2", [
          "--layout",
          "elk",
          "--theme",
          "300",
          source,
          path.join(svgDirectory, `${name}.svg`)
        ])
      }, { concurrency: 4, discard: true })
      yield* Console.log("✓ built png in ./out and svg in ./out-svg")
    })

    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.exit(restore(workflow)).pipe(
        Effect.flatMap((primary) => {
          if (Exit.isSuccess(primary)) return Effect.succeed(primary.value)
          return Effect.exit(cleanOutputs(root)).pipe(
            Effect.flatMap((cleanup) => Exit.isFailure(cleanup)
              ? Effect.failCause(Cause.combine(primary.cause, cleanup.cause))
              : Effect.failCause(primary.cause))
          )
        })
      )
    )
  }
)

const program = Path.Path.pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("../", import.meta.url))),
  Effect.flatMap(buildArchitecture),
  Effect.provide(NodeServices.layer)
)

if (import.meta.main) {
  NodeRuntime["runMain"](program)
}
