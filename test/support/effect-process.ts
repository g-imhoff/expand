import { Effect, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

export class CommandReport extends Schema.Class<CommandReport>("CommandReport")({
  stdout: Schema.String,
  stderr: Schema.String,
  exitCode: Schema.Number
}) {}

export class CommandFixtureError extends Schema.TaggedErrorClass<CommandFixtureError>()(
  "CommandFixtureError",
  {
    command: Schema.String,
    cause: Schema.Defect
  }
) {}

export interface RunCommandOptions extends ChildProcess.CommandOptions {}

export const runCommand = Effect.fn("TestSupport.runCommand")(
  (
    command: string,
    args: ReadonlyArray<string>,
    options: RunCommandOptions = {}
  ): Effect.Effect<CommandReport, CommandFixtureError, ChildProcessSpawner.ChildProcessSpawner> =>
    Effect.scoped(Effect.gen(function*() {
      const handle = yield* ChildProcess.make(command, args, options)
      const [stdout, stderr, exitCode] = yield* Effect.all([
        handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
        handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
        handle.exitCode
      ], { concurrency: "unbounded" })
      return new CommandReport({ stdout, stderr, exitCode })
    })).pipe(
      Effect.mapError((cause) => new CommandFixtureError({ command, cause }))
    )
)
