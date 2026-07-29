import { Cause, Data, Deferred, Effect, Exit, FileSystem, Path, Ref, Stream, SubscriptionRef } from "effect"
import { ChildProcess } from "effect/unstable/process"

export interface RunResult { readonly code: number; readonly stdout: string; readonly stderr: string }

export class ExampleProcessError extends Data.TaggedError("ExampleProcessError")<{
  readonly operation: "spawn" | "stdout" | "stderr" | "exit" | "kill"
  readonly cause: unknown
}> {}

export class ExampleReadinessError extends Data.TaggedError("ExampleReadinessError")<{
  readonly substring: string
  readonly lines: ReadonlyArray<string>
  readonly reason: "timeout" | "exit"
}> {}

export interface ExampleHandle {
  /** Kill the process and await its exit, so cleanup never races the dying backend. */
  readonly kill: Effect.Effect<void, ExampleProcessError>
  /**
   * Resolve once a stdout line containing `substr` has appeared (matches lines
   * seen before the call too). Rejects on `timeoutMs` or if the process exits
   * first without emitting a matching line.
   */
  readonly waitForLine: (substr: string, timeoutMs: number) => Effect.Effect<void, ExampleReadinessError | ExampleProcessError>
  readonly awaitExit: Effect.Effect<RunResult, ExampleProcessError>
}

/** Create an isolated, caller-owned data dir. Caller removes it (e.g. `rmSync(..., { recursive: true })`). */
export const makeDataDir = Effect.fn("ClientExampleTest.makeDataDir")(() =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix: "expand-ex-" }))
  ))

export const runExample = Effect.fn("ClientExampleTest.runExample")(
  (relPath: string, args: ReadonlyArray<string>, dataDir?: string) =>
    Effect.scoped(Effect.gen(function*() {
      const dir = dataDir ?? (yield* makeDataDir())
      const handle = yield* spawnExample(relPath, args, dir)
      return yield* handle.awaitExit
    }))
)

/**
 * Spawn a long-running example against a caller-owned `dataDir` and return a handle
 * immediately (without awaiting exit), so a test can let it run then `kill()` it.
 *
 * stdout is PIPED (not inherited) so callers can deterministically await a
 * readiness line via `waitForLine` instead of sleeping; stderr is inherited for
 * debugging. The caller owns `dataDir`.
 */
export const spawnExample = Effect.fn("ClientExampleTest.spawnExample")(function*(
  relPath: string,
  args: ReadonlyArray<string>,
  dataDir: string
) {
  const path = yield* Path.Path
  const examplesDir = yield* path.fromFileUrl(new URL("../", import.meta.url)).pipe(Effect.orDie)
  const handle = yield* ChildProcess.make(
    "node",
    ["--import", "tsx", path.join(examplesDir, relPath), ...args, "--data-dir", dataDir],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" }
  ).pipe(Effect.mapError((cause) => new ExampleProcessError({ operation: "spawn", cause })))
  const stdout = yield* Ref.make("")
  const stderr = yield* Ref.make("")
  const lines = yield* SubscriptionRef.make<ReadonlyArray<string>>([])
  const exit = yield* Deferred.make<RunResult, ExampleProcessError>()
  const collectStdout = Effect.gen(function*() {
    let buffer = ""
    yield* handle.stdout.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) => Effect.gen(function*() {
        yield* Ref.update(stdout, (output) => output + chunk)
        buffer += chunk
        let newline = buffer.indexOf("\n")
        while (newline >= 0) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          yield* SubscriptionRef.update(lines, (seen) => [...seen, line])
          newline = buffer.indexOf("\n")
        }
      })),
      Effect.mapError((cause) => new ExampleProcessError({ operation: "stdout", cause }))
    )
    if (buffer.length > 0) yield* SubscriptionRef.update(lines, (seen) => [...seen, buffer])
  })
  const collectStderr = handle.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) => Ref.update(stderr, (output) => output + chunk)),
    Effect.mapError((cause) => new ExampleProcessError({ operation: "stderr", cause }))
  )
  yield* Effect.all([
    collectStdout,
    collectStderr,
    handle.exitCode.pipe(
      Effect.mapError((cause) => new ExampleProcessError({ operation: "exit", cause }))
    )
  ], { concurrency: "unbounded" }).pipe(
    Effect.flatMap(([_, __, code]) => Effect.all([Ref.get(stdout), Ref.get(stderr)]).pipe(
      Effect.flatMap(([stdout, stderr]) => Deferred.succeed(exit, { code: Number(code), stdout, stderr }))
    )),
    Effect.catchCause((cause) => Deferred.failCause(exit, cause)),
    Effect.forkScoped
  )
  const awaitExit = Deferred.await(exit)
  const kill = yield* Effect.cached(Effect.uninterruptible(handle.isRunning.pipe(
    Effect.mapError((cause) => new ExampleProcessError({ operation: "kill", cause })),
    Effect.flatMap((running) => running
      ? handle.kill().pipe(Effect.mapError((cause) => new ExampleProcessError({ operation: "kill", cause })))
      : Effect.void),
    Effect.andThen(Effect.exit(awaitExit)),
    Effect.asVoid
  )))
  return {
    kill,
    awaitExit,
    waitForLine: (substring: string, timeoutMs: number) => waitForLine(lines, awaitExit, kill, substring, timeoutMs)
  }
})

export const waitForLine = Effect.fn("ClientExampleTest.waitForLine")(function*<E>(
  lines: SubscriptionRef.SubscriptionRef<ReadonlyArray<string>>,
  awaitExit: Effect.Effect<unknown, unknown>,
  close: Effect.Effect<void, E>,
  substring: string,
  timeoutMs: number
) {
  const seen = yield* SubscriptionRef.get(lines)
  if (seen.some((line) => line.includes(substring))) return
  return yield* Effect.scoped(Effect.gen(function*() {
    const readiness = yield* Deferred.make<void, ExampleReadinessError>()
    yield* SubscriptionRef.changes(lines).pipe(
      Stream.runForEach((current) => current.some((line) => line.includes(substring))
        ? Deferred.succeed(readiness, undefined).pipe(Effect.asVoid)
        : Effect.void),
      Effect.forkScoped
    )
    yield* awaitExit.pipe(
      Effect.exit,
      Effect.flatMap(() => SubscriptionRef.get(lines)),
      Effect.flatMap((current) => Deferred.fail(readiness, new ExampleReadinessError({
        substring,
        lines: current,
        reason: "exit"
      }))),
      Effect.forkScoped
    )
    return yield* Deferred.await(readiness).pipe(
      Effect.timeoutOrElse({
        duration: `${timeoutMs} millis`,
        orElse: () => SubscriptionRef.get(lines).pipe(
          Effect.flatMap((current) => Effect.fail(new ExampleReadinessError({
            substring,
            lines: current,
            reason: "timeout"
          })))
        )
      }),
      Effect.exit
    )
  })).pipe(Effect.flatMap((readinessExit) => Exit.isSuccess(readinessExit)
    ? Effect.void
    : close.pipe(Effect.matchCauseEffect({
      onFailure: (cleanupCause) => Effect.failCause(Cause.combine(readinessExit.cause, cleanupCause)),
      onSuccess: () => Effect.failCause(readinessExit.cause)
    }))))
})

/** Create a temp dir containing the named subdirectories; returns its path. Caller removes it. */
export const makeFixtureDir = Effect.fn("ClientExampleTest.makeFixtureDir")(function*(subdirs: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "expand-fixture-" })
  yield* Effect.forEach(subdirs, (subdir) => fs.makeDirectory(path.join(dir, subdir)))
  return dir
})
