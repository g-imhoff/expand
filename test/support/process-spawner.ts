import { Effect, Layer, Sink, Stream } from "effect"
import { ChildProcessSpawner, type ChildProcess } from "effect/unstable/process"

export interface SpawnRecord {
  readonly command: ChildProcess.Command
  readonly released: boolean
}

export interface ProcessSpawnerFixture {
  readonly records: Array<SpawnRecord>
  readonly layer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>
}

export const processSpawnerFixture = (
  exitCodes: ReadonlyArray<number>,
  options: { readonly neverExitAt?: number } = {}
): ProcessSpawnerFixture => {
  const records: Array<{ command: ChildProcess.Command; released: boolean }> = []
  let index = 0
  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const current = index++
      const record = { command, released: false }
      records.push(record)
      return Effect.acquireRelease(
        Effect.succeed(ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(current + 1),
          exitCode: current === options.neverExitAt
            ? Effect.never
            : Effect.succeed(ChildProcessSpawner.ExitCode(exitCodes[current] ?? 0)),
          isRunning: Effect.succeed(current === options.neverExitAt),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void)
        })),
        () => Effect.sync(() => {
          record.released = true
        })
      )
    })
  )
  return { records, layer }
}
