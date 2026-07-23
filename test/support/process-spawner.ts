import { Effect, Layer, Sink, Stream } from "effect"
import { ChildProcessSpawner, type ChildProcess } from "effect/unstable/process"

export interface SpawnRecord {
  readonly command: ChildProcess.Command
  readonly released: boolean
  readonly releaseCount: number
}

export interface ProcessSpawnerFixture {
  readonly records: Array<SpawnRecord>
  readonly layer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>
}

export const processSpawnerFixture = (
  exitCodes: ReadonlyArray<number>,
  options: { readonly neverExitAt?: number; readonly eventLog?: Array<string> } = {}
): ProcessSpawnerFixture => {
  const records: Array<{ command: ChildProcess.Command; released: boolean; releaseCount: number }> = []
  let index = 0
  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const current = index++
      const name = command._tag === "StandardCommand" ? command.command : "pipe"
      const record = { command, released: false, releaseCount: 0 }
      records.push(record)
      options.eventLog?.push(`spawn:${name}`)
      return Effect.acquireRelease(
        Effect.succeed(ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(current + 1),
          exitCode: current === options.neverExitAt
            ? Effect.never
            : Effect.sync(() => {
              options.eventLog?.push(`exit:${name}`)
              return ChildProcessSpawner.ExitCode(exitCodes[current] ?? 0)
            }),
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
          record.releaseCount += 1
          options.eventLog?.push(`release:${name}`)
        })
      )
    })
  )
  return { records, layer }
}
