import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, Exit, Fiber, FileSystem, Layer, Path } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect } from "vitest"
import type { ProjectClientApi } from "@expand/client-ts/project"
import { ProjectClient } from "@expand/client-ts/project"
import { ArchiveRpcError, archiveStale, waitForBackendShutdown } from "../archive-stale"
import { makeDataDir, makeFixtureDir, runExample, spawnExample } from "./helpers"

const clientLayer = (client: ProjectClientApi) => Layer.succeed(ProjectClient, client)

describe("example: archive-stale", () => {
  it.effect("uses TestClock-compatible bounded polling for backend shutdown", () => {
    let checks = 0
    return Effect.gen(function*() {
      const fiber = yield* waitForBackendShutdown("/state/backend.lock").pipe(
        Effect.provide(FileSystem.layerNoop({
          exists: () => Effect.sync(() => ++checks < 3)
        })),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.yieldNow
      expect(checks).toBe(1)
      yield* TestClock.adjust("50 millis")
      expect(checks).toBe(2)
      yield* TestClock.adjust("50 millis")
      yield* Fiber.join(fiber)
      expect(checks).toBe(3)
    })
  })

  it.effect("reports list RPC failures through the typed channel", () => {
    const client = {
      list: () => Effect.fail({ reason: "rpc" })
    } as unknown as ProjectClientApi
    return archiveStale.pipe(
      Effect.provide(FileSystem.layerNoop({})),
      Effect.provide(clientLayer(client)),
      Effect.flip,
      Effect.tap((error) => Effect.sync(() => {
        expect(error).toBeInstanceOf(ArchiveRpcError)
        if (error._tag === "ArchiveRpcError") expect(error.operation).toBe("list")
      }))
    )
  })

  it.effect("archives projects whose directory is gone", () =>
    Effect.scoped(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const fixture = yield* fs.makeTempDirectoryScoped({ prefix: "expand-fixture-" })
      const gone = path.join(fixture, "gone")
      yield* fs.makeDirectory(gone) // becomes project "gone" -> <fixture>/gone
      yield* fs.remove(gone, { recursive: true, force: true }) // its directory is now stale
      const archived: Array<string> = []
      const client = {
        list: () => Effect.succeed({ projects: [{ id: "project-1", name: "gone", directory: gone }], seq: 1 }),
        archive: ({ id }: { readonly id: string }) => Effect.sync(() => {
          archived.push(id)
          return {}
        })
      } as unknown as ProjectClientApi

      yield* archiveStale.pipe(Effect.provide(clientLayer(client)))

      expect(archived).toEqual(["project-1"])
    })).pipe(Effect.provide(NodeServices.layer)))

  it.live("cleans the spawned process and owned directory after assertion failure", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      let ownedDataDir = ""
      const exit = yield* Effect.exit(Effect.scoped(Effect.gen(function*() {
        ownedDataDir = yield* makeDataDir()
        const fixture = yield* makeFixtureDir(["gone"])
        const audit = yield* spawnExample("audit-log.ts", [path.join(ownedDataDir, "audit.jsonl")], ownedDataDir)
        yield* audit.waitForLine("audit-log: writing to", 30_000)
        yield* runExample("bootstrap-projects.ts", [fixture], ownedDataDir)
        return yield* Effect.fail("assertion failed" as const)
      })))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* fs.exists(ownedDataDir)).toBe(false)
    }).pipe(Effect.provide(NodeServices.layer)))
})
