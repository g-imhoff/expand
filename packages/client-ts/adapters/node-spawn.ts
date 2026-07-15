import { Effect, type Scope } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { BackendUnavailable } from "../errors"

export const spawnResolvedBackend = Effect.fn("NodeAdapter.spawnResolvedBackend")(function*(
  command: ReadonlyArray<string>,
  dataDir: string
): Effect.fn.Return<
  void,
  BackendUnavailable,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  const [executable, ...configuredArgs] = command
  const renderedCommand = command.join(" ") || "<empty>"
  if (executable === undefined) {
    return yield* new BackendUnavailable({
      reason: `spawn failed: ${renderedCommand}: command is empty`
    })
  }

  const mapPlatformError = (error: unknown) => new BackendUnavailable({
    reason: `spawn failed: ${renderedCommand}: ${String(error)}`
  })
  const handle = yield* ChildProcess.make(
    executable,
    [...configuredArgs, "--data-dir", dataDir],
    {
      detached: false,
      extendEnv: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore"
    }
  ).pipe(Effect.mapError(mapPlatformError))

  yield* handle.unref.pipe(
    Effect.mapError(mapPlatformError),
    Effect.asVoid
  )
})
