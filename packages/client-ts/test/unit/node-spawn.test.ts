import { it } from "@effect/vitest"
import {
  Effect,
  Fiber,
  Layer,
  PlatformError,
  Sink,
  Stream
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { describe, expect } from "vitest"
import { spawnResolvedBackend } from "../../adapters/node-spawn"

const dataDir = "/state root"

describe("Node Effect child process spawning", () => {
  it.effect("preserves command order, appends the data directory, and unreferences once", () => {
    const commands: Array<ChildProcess.StandardCommand> = []
    let unrefs = 0
    const handle = makeHandle({
      unref: Effect.sync(() => {
        unrefs += 1
        return Effect.void
      })
    })
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        if (command._tag === "StandardCommand") commands.push(command)
        return handle
      }))

    return runSpawn(["expand-server", "--config", "project.json"], spawner).pipe(
      Effect.tap(() => Effect.sync(() => {
        expect(commands).toHaveLength(1)
        expect(commands[0]).toMatchObject({
          command: "expand-server",
          args: ["--config", "project.json", "--data-dir", dataDir],
          options: {
            detached: false,
            extendEnv: true,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore"
          }
        })
        expect(Object.keys(commands[0]!.options).sort()).toEqual([
          "detached",
          "extendEnv",
          "stderr",
          "stdin",
          "stdout"
        ])
        expect(unrefs).toBe(1)
      }))
    )
  })

  it.effect("closes the scope after unref without killing the accepted child", () => {
    let referenced = true
    let kills = 0
    const scopeSnapshots: Array<boolean> = []
    const handle = makeHandle({
      unref: Effect.sync(() => {
        referenced = false
        return Effect.sync(() => {
          referenced = true
        })
      })
    })
    const spawner = ChildProcessSpawner.make(() =>
      Effect.gen(function*() {
        yield* Effect.addFinalizer(() => Effect.sync(() => {
          scopeSnapshots.push(referenced)
          if (referenced) kills += 1
        }))
        return handle
      }))

    return runSpawn(["expand-server"], spawner).pipe(
      Effect.tap(() => Effect.sync(() => {
        expect(scopeSnapshots).toEqual([false])
        expect(kills).toBe(0)
      }))
    )
  })

  it.effect("maps a typed spawn failure once with the rendered command", () => {
    const failure = platformFailure("spawn", "missing executable")
    let spawns = 0
    const spawner = ChildProcessSpawner.make(() => {
      spawns += 1
      return Effect.fail(failure)
    })

    return Effect.result(runSpawn(["missing", "--flag"], spawner)).pipe(
      Effect.tap((result) => Effect.sync(() => {
        expect(spawns).toBe(1)
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "BackendUnavailable",
            reason: `spawn failed: missing --flag: ${String(failure)}`
          }
        })
      }))
    )
  })

  it.effect("maps a typed unref failure once with the rendered command", () => {
    const failure = platformFailure("unref", "cannot unreference")
    let unrefs = 0
    const handle = makeHandle({
      unref: Effect.suspend(() => {
        unrefs += 1
        return Effect.fail(failure)
      })
    })
    const spawner = ChildProcessSpawner.make(() => Effect.succeed(handle))

    return Effect.result(runSpawn(["expand-server", "serve"], spawner)).pipe(
      Effect.tap((result) => Effect.sync(() => {
        expect(unrefs).toBe(1)
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "BackendUnavailable",
            reason: `spawn failed: expand-server serve: ${String(failure)}`
          }
        })
      }))
    )
  })

  it.effect("cancels a pending spawn, ignores late success, and never unreferences", () =>
    Effect.gen(function*() {
      let cancellations = 0
      let unrefs = 0
      let resumeSpawn: ((effect: Effect.Effect<ChildProcessSpawner.ChildProcessHandle, PlatformError.PlatformError>) => void) | undefined
      const handle = makeHandle({
        unref: Effect.sync(() => {
          unrefs += 1
          return Effect.void
        })
      })
      const spawner = ChildProcessSpawner.make(() =>
        Effect.callback<ChildProcessSpawner.ChildProcessHandle, PlatformError.PlatformError>((resume) => {
          resumeSpawn = resume
          return Effect.sync(() => {
            cancellations += 1
          })
        }))
      const fiber = yield* Effect.forkChild(
        runSpawn(["expand-server"], spawner),
        { startImmediately: true }
      )

      expect(resumeSpawn).toBeTypeOf("function")
      yield* Fiber.interrupt(fiber)
      resumeSpawn?.(Effect.succeed(handle))
      resumeSpawn?.(Effect.succeed(handle))
      yield* Effect.yieldNow

      expect(cancellations).toBe(1)
      expect(unrefs).toBe(0)
    }))

  it.effect("rejects an empty command without invoking the spawner or defecting", () => {
    let spawns = 0
    const spawner = ChildProcessSpawner.make(() => {
      spawns += 1
      return Effect.succeed(makeHandle())
    })

    return Effect.result(runSpawn([], spawner)).pipe(
      Effect.tap((result) => Effect.sync(() => {
        expect(spawns).toBe(0)
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "BackendUnavailable",
            reason: expect.stringMatching(/^spawn failed: <empty>:/)
          }
        })
      }))
    )
  })
})

const runSpawn = (
  command: ReadonlyArray<string>,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
) => spawnResolvedBackend(command, dataDir).pipe(
  Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
  Effect.scoped
)

const makeHandle = (options?: {
  readonly unref?: ChildProcessSpawner.ChildProcessHandle["unref"] | undefined
}) => ChildProcessSpawner.makeHandle({
  pid: ChildProcessSpawner.ProcessId(123),
  exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
  isRunning: Effect.succeed(true),
  kill: () => Effect.void,
  stdin: Sink.drain,
  stdout: Stream.empty,
  stderr: Stream.empty,
  all: Stream.empty,
  getInputFd: () => Sink.drain,
  getOutputFd: () => Stream.empty,
  unref: options?.unref ?? Effect.succeed(Effect.void)
})

const platformFailure = (method: string, description: string) => PlatformError.systemError({
  _tag: "NotFound",
  module: "ChildProcess",
  method,
  description
})
