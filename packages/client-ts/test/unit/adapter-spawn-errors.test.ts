import { it } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
import { tmpdir } from "node:os"
import { describe, expect } from "vitest"
import { makeNodeAdapter } from "../../adapters/node"
import { resolveBackendCommand, type BackendCommandError } from "../../index"

const dir = tmpdir()
const missingExecutable = "/definitely/missing/expand-server-xyz"

const provideFileSystem = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  effect.pipe(Effect.provide(FileSystem.layerNoop({})))

describe("node adapter spawn errors", () => {
  it.effect("fails with BackendUnavailable when the binary does not exist", () => {
    const adapter = makeNodeAdapter({ backendCommand: Effect.succeed([missingExecutable]) })
    return provideFileSystem(Effect.result(adapter.spawnBackend(dir))).pipe(
      Effect.tap((result) => Effect.sync(() => {
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          expect(result.failure._tag).toBe("BackendUnavailable")
          expect(result.failure.reason).toContain("spawn failed")
        }
      }))
    )
  })

  it.effect("fails with BackendUnavailable when the backend command is empty", () => {
    const adapter = makeNodeAdapter({ backendCommand: Effect.succeed([]) })
    return provideFileSystem(Effect.result(adapter.spawnBackend(dir))).pipe(
      Effect.tap((result) => Effect.sync(() => {
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          expect(result.failure._tag).toBe("BackendUnavailable")
          expect(result.failure.reason).toContain("spawn failed: <empty>:")
        }
      }))
    )
  })

  it.effect("maps BackendCommandError to BackendUnavailable once", () => {
    const commandError = {
      _tag: "BackendCommandError",
      reason: "invalid-override",
      detail: "override failed"
    } as unknown as BackendCommandError
    const adapter = makeNodeAdapter({ backendCommand: Effect.fail(commandError) })
    return provideFileSystem(Effect.result(adapter.spawnBackend(dir))).pipe(
      Effect.tap((result) => Effect.sync(() => {
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "BackendUnavailable",
            reason: "invalid backend command: invalid-override: override failed"
          }
        })
      }))
    )
  })

  it.effect("does not resolve the command or access the filesystem when constructed", () =>
    Effect.sync(() => {
      let optionReads = 0
      let fileSystemReads = 0
      const options = {
        execPath: "node",
        get sourceEntry() {
          optionReads += 1
          return "/source/server.ts"
        }
      }
      const backendCommand = resolveBackendCommand(options).pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            exists: () => Effect.sync(() => {
              fileSystemReads += 1
              return true
            })
          })
        )
      )

      makeNodeAdapter({ backendCommand })

      expect(optionReads).toBe(0)
      expect(fileSystemReads).toBe(0)
    }))
})
