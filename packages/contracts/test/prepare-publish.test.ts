import * as NodePlatform from "@effect/platform-node"
import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, Path, Schema } from "effect"
import { describe, expect, vi } from "vitest"
import { processSpawnerFixture } from "../../../test/support/process-spawner"
import {
  PublishCommandError,
  PublishManifestError,
  PublishStageError,
  build,
  pack,
  stage
} from "../scripts/prepare-publish"

const SourceManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  private: Schema.Boolean,
  type: Schema.Literal("module"),
  sideEffects: Schema.Boolean,
  exports: Schema.Unknown,
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String))
})

const PublishedManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  private: Schema.Boolean,
  type: Schema.Literal("module"),
  sideEffects: Schema.Boolean,
  exports: Schema.Unknown,
  files: Schema.Array(Schema.String),
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String))
})

const sourceManifest = {
  name: "@expand/contracts",
  version: "1.2.3",
  private: true,
  type: "module" as const,
  sideEffects: false,
  exports: { "./*": "./*.ts" },
  dependencies: { effect: "4.0.0-beta.74" }
}

const sourceJson = Schema.encodeSync(Schema.fromJsonString(SourceManifest))(sourceManifest)

const withFixture = Effect.fn("ContractsPublishTest.withFixture")(
  function*<A, E, R>(use: (root: string) => Effect.Effect<A, E, R>) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "expand-contracts-publish-" })
    yield* fs.writeFileString(
      path.join(root, "package.json"),
      sourceJson
    )
    return yield* use(root)
  }
)

const live = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(
  Effect.scoped,
  Effect.provide(NodeServices.layer)
)

const expectNoTransactionArtifacts = (fs: FileSystem.FileSystem, path: Path.Path, root: string) =>
  Effect.gen(function*() {
    expect(yield* fs.exists(path.join(root, ".dist-publish.next"))).toBe(false)
    expect(yield* fs.exists(path.join(root, ".dist-publish.previous"))).toBe(false)
  })

describe("contracts publish workflow", () => {
  it.live("fails when dist is missing without replacing an existing stage", () =>
    live(withFixture((root) => Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.makeDirectory(path.join(root, "dist-publish"))
      yield* fs.writeFileString(path.join(root, "dist-publish", "marker"), "old")

      const error = yield* stage(root).pipe(Effect.flip)

      expect(error).toBeInstanceOf(PublishStageError)
      if (error._tag === "PublishStageError") expect(error.operation).toBe("missing-dist")
      expect(yield* fs.readFileString(path.join(root, "dist-publish", "marker"))).toBe("old")
    }))))

  it.live("keeps filesystem manifest reads in the read-manifest error category", () =>
    live(withFixture((root) => Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const failure = { reason: "injected read failure" }
      yield* fs.makeDirectory(path.join(root, "dist"))

      const error = yield* stage(root).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readFileString: (target, options) => target === path.join(root, "package.json")
            ? Effect.fail(failure as never)
            : fs.readFileString(target, options)
        }),
        Effect.flip
      )

      expect(error).toEqual(new PublishStageError({ operation: "read-manifest", cause: failure }))
      expect(error).not.toBeInstanceOf(PublishManifestError)
    }))))

  it.live("rejects malformed package metadata without exposing partial output", () =>
    live(withFixture((root) => Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.makeDirectory(path.join(root, "dist"))
      yield* fs.writeFileString(path.join(root, "dist", "index.js"), "export {}\n")
      yield* fs.makeDirectory(path.join(root, "dist-publish"))
      yield* fs.writeFileString(path.join(root, "dist-publish", "marker"), "old")
      yield* fs.writeFileString(path.join(root, "package.json"), "{")

      const error = yield* stage(root).pipe(Effect.flip)

      expect(error).toBeInstanceOf(PublishManifestError)
      expect(error).not.toBeInstanceOf(PublishStageError)
      expect(yield* fs.readFileString(path.join(root, "dist-publish", "marker"))).toBe("old")
      expect(yield* fs.exists(path.join(root, ".dist-publish.next"))).toBe(false)
    }))))

  it.live("restores exact prior bytes and removes artifacts after persistent copy and write failures", () =>
    live(Effect.gen(function*() {
      for (const operation of ["copy", "write"] as const) {
        yield* withFixture((root) => Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const failure = { operation }
          yield* fs.makeDirectory(path.join(root, "dist"))
          yield* fs.writeFileString(path.join(root, "dist", "index.js"), "new bytes")
          yield* fs.makeDirectory(path.join(root, "dist-publish"))
          yield* fs.writeFileString(path.join(root, "dist-publish", "marker"), "original bytes")
          yield* fs.makeDirectory(path.join(root, ".dist-publish.next"))
          yield* fs.writeFileString(path.join(root, ".dist-publish.next", "stale"), "stale next")
          yield* fs.makeDirectory(path.join(root, ".dist-publish.previous"))
          yield* fs.writeFileString(path.join(root, ".dist-publish.previous", "stale"), "stale previous")
          const injected = {
            ...fs,
            copy: (from: string, to: string, options?: Parameters<typeof fs.copy>[2]) => fs.copy(from, to, options).pipe(
              Effect.andThen(operation === "copy" ? Effect.fail(failure as never) : Effect.void)
            ),
            writeFileString: (target: string, value: string, options?: Parameters<typeof fs.writeFileString>[2]) => fs.writeFileString(target, value, options).pipe(
              Effect.andThen(operation === "write" ? Effect.fail(failure as never) : Effect.void)
            )
          }

          const error = yield* stage(root).pipe(
            Effect.provideService(FileSystem.FileSystem, injected),
            Effect.flip
          )

          expect(error).toBeInstanceOf(PublishStageError)
          expect(yield* fs.readFileString(path.join(root, "dist-publish", "marker"))).toBe("original bytes")
          yield* expectNoTransactionArtifacts(fs, path, root)
        }))
      }
    })))

  it.live("restores original or absent output after persistent rename failures", () =>
    live(Effect.gen(function*() {
      for (const scenario of [
        { prior: true, failFrom: 1 },
        { prior: true, failFrom: 2 },
        { prior: false, failFrom: 1 }
      ] as const) {
        yield* withFixture((root) => Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const failure = { scenario }
          let renames = 0
          yield* fs.makeDirectory(path.join(root, "dist"))
          yield* fs.writeFileString(path.join(root, "dist", "index.js"), "new bytes")
          if (scenario.prior) {
            yield* fs.makeDirectory(path.join(root, "dist-publish"))
            yield* fs.writeFileString(path.join(root, "dist-publish", "marker"), "original bytes")
          }
          const injected = {
            ...fs,
            rename: (from: string, to: string) => fs.rename(from, to).pipe(
              Effect.andThen(Effect.suspend(() => {
                renames += 1
                return renames >= scenario.failFrom ? Effect.fail(failure as never) : Effect.void
              }))
            )
          }

          yield* stage(root).pipe(
            Effect.provideService(FileSystem.FileSystem, injected),
            Effect.flip
          )

          if (scenario.prior) {
            expect(yield* fs.readFileString(path.join(root, "dist-publish", "marker"))).toBe("original bytes")
          } else {
            expect(yield* fs.exists(path.join(root, "dist-publish"))).toBe(false)
          }
          yield* expectNoTransactionArtifacts(fs, path, root)
        }))
      }
    })))

  it.live("rolls back an interrupted copy at an explicit mutation barrier", () =>
    live(withFixture((root) => Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const copied = yield* Deferred.make<void>()
      yield* fs.makeDirectory(path.join(root, "dist"))
      yield* fs.writeFileString(path.join(root, "dist", "index.js"), "new bytes")
      yield* fs.makeDirectory(path.join(root, "dist-publish"))
      yield* fs.writeFileString(path.join(root, "dist-publish", "marker"), "original bytes")
      const fiber = yield* stage(root).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          copy: (from, to, options) => fs.copy(from, to, options).pipe(
            Effect.andThen(Deferred.succeed(copied, undefined)),
            Effect.andThen(Effect.never)
          )
        }),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred["a\u0077ait"](copied)
      yield* Fiber.interrupt(fiber)
      expect(yield* fs.readFileString(path.join(root, "dist-publish", "marker"))).toBe("original bytes")
      yield* expectNoTransactionArtifacts(fs, path, root)
    }))))

  it.live("defers interruption across backup and promotion bookkeeping", () =>
    live(Effect.gen(function*() {
      for (const barrierAt of [1, 2] as const) {
        yield* withFixture((root) => Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          let renames = 0
          yield* fs.makeDirectory(path.join(root, "dist"))
          yield* fs.writeFileString(path.join(root, "dist", "index.js"), "new bytes")
          yield* fs.makeDirectory(path.join(root, "dist-publish"))
          yield* fs.writeFileString(path.join(root, "dist-publish", "marker"), "original bytes")
          const fiber = yield* stage(root).pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              rename: (from, to) => fs.rename(from, to).pipe(
                Effect.andThen(Effect.suspend(() => {
                  renames += 1
                  return renames === barrierAt
                    ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred["a\u0077ait"](release)))
                    : Effect.void
                }))
              )
            }),
            Effect.forkChild({ startImmediately: true })
          )
          yield* Deferred["a\u0077ait"](entered)
          const interrupt = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Effect.yieldNow
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(interrupt)
          expect(yield* fs.readFileString(path.join(root, "dist-publish", "marker"))).toBe("original bytes")
          expect(yield* fs.exists(path.join(root, "dist-publish", "dist", "index.js"))).toBe(false)
          yield* expectNoTransactionArtifacts(fs, path, root)
        }))
      }
    })))

  it.live("combines a primary mutation failure with cleanup failures", () =>
    live(withFixture((root) => Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const primary = { reason: "copy" }
      const cleanup = { reason: "cleanup" }
      let copied = false
      yield* fs.makeDirectory(path.join(root, "dist"))
      yield* fs.writeFileString(path.join(root, "dist", "index.js"), "new bytes")
      const exit = yield* stage(root).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          copy: (from, to, options) => fs.copy(from, to, options).pipe(
            Effect.tap(() => Effect.sync(() => {
              copied = true
            })),
            Effect.andThen(Effect.fail(primary as never))
          ),
          remove: (target, options) => fs.remove(target, options).pipe(
            Effect.andThen(copied && target.endsWith(".dist-publish.next") ? Effect.fail(cleanup as never) : Effect.void)
          )
        }),
        Effect.exit
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(exit.cause.reasons.filter(Cause.isFailReason)).toHaveLength(2)
      yield* expectNoTransactionArtifacts(fs, path, root)
    }))))

  it.live("recursively stages dist, removes stale output, and writes the exact public export map", () =>
    live(withFixture((root) => Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.makeDirectory(path.join(root, "dist", "events"), { recursive: true })
      yield* fs.writeFileString(path.join(root, "dist", "events", "domain-event.js"), "export {}\n")
      yield* fs.writeFileString(path.join(root, "dist", "events", "domain-event.d.ts"), "export {}\n")
      yield* fs.makeDirectory(path.join(root, "dist-publish"))
      yield* fs.writeFileString(path.join(root, "dist-publish", "stale"), "remove")

      yield* stage(root)

      expect(yield* fs.exists(path.join(root, "dist-publish", "stale"))).toBe(false)
      expect(yield* fs.readFileString(path.join(root, "dist-publish", "dist", "events", "domain-event.js"))).toBe("export {}\n")
      const manifest = yield* fs.readFileString(path.join(root, "dist-publish", "package.json")).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(PublishedManifest)))
      )
      expect(manifest).toEqual({
        name: "@expand/contracts",
        version: "1.2.3",
        type: "module",
        sideEffects: false,
        private: false,
        exports: {
          "./events/domain-event": null,
          "./package.json": "./package.json",
          "./*": {
            types: "./dist/*.d.ts",
            import: "./dist/*.js",
            default: "./dist/*.js"
          }
        },
        files: ["dist"],
        dependencies: { effect: "4.0.0-beta.74" }
      })
    }))))

  it.effect("runs the scoped build command in the package directory and tags nonzero exit", () => {
    const fixture = processSpawnerFixture([9])
    return build("/repo/packages/contracts").pipe(
      Effect.provide(fixture.layer),
      Effect.flip,
      Effect.tap((error) => Effect.sync(() => {
        expect(error).toEqual(new PublishCommandError({ command: "tsc", exitCode: 9 }))
        expect(fixture.records).toHaveLength(1)
        const command = fixture.records[0]?.command
        expect(command?._tag).toBe("StandardCommand")
        if (command?._tag === "StandardCommand") {
          expect(command.command).toBe("tsc")
          expect(command.args).toEqual(["-p", "tsconfig.build.json"])
          expect(command.options.cwd).toBe("/repo/packages/contracts")
        }
        expect(fixture.records[0]?.released).toBe(true)
      }))
    )
  })

  it.effect("packs by building, staging, then invoking npm pack in one lazy Effect", () => {
    const operations: Array<string> = []
    const fixture = processSpawnerFixture([0, 0], { eventLog: operations })
    const program = pack("/repo/packages/contracts").pipe(
      Effect.provide(fixture.layer),
      Effect.provide(FileSystem.layerNoop({
        exists: (target) => Effect.sync(() => {
          operations.push(`exists:${target}`)
          return true
        }),
        readFileString: () => Effect.succeed(sourceJson),
        remove: (target) => Effect.sync(() => operations.push(`remove:${target}`)),
        makeDirectory: (target) => Effect.sync(() => operations.push(`mkdir:${target}`)),
        copy: (from, to) => Effect.sync(() => operations.push(`copy:${from}:${to}`)),
        writeFileString: (target) => Effect.sync(() => operations.push(`write:${target}`)),
        rename: (from, to) => Effect.sync(() => operations.push(`rename:${from}:${to}`))
      })),
      Effect.provide(Path.layer)
    )

    expect(Effect.isEffect(program)).toBe(true)
    expect(fixture.records).toHaveLength(0)

    return program.pipe(Effect.tap(() => Effect.sync(() => {
      expect(fixture.records.map((record) => record.command._tag === "StandardCommand" ? record.command.command : "pipe"))
        .toEqual(["tsc", "npm"])
      const npm = fixture.records[1]?.command
      expect(npm?._tag).toBe("StandardCommand")
      if (npm?._tag === "StandardCommand") {
        expect(npm.args).toEqual(["pack", "./dist-publish"])
        expect(npm.options.cwd).toBe("/repo/packages/contracts")
      }
      expect(operations.indexOf("exit:tsc")).toBeLessThan(operations.indexOf("copy:/repo/packages/contracts/dist:/repo/packages/contracts/.dist-publish.next/dist"))
      expect(operations.indexOf("rename:/repo/packages/contracts/.dist-publish.next:/repo/packages/contracts/dist-publish")).toBeLessThan(operations.indexOf("spawn:npm"))
    })))
  })

  it.effect("returns the exact tagged npm pack nonzero failure after build and stage", () => {
    const events: Array<string> = []
    const fixture = processSpawnerFixture([0, 6], { eventLog: events })
    return pack("/repo/packages/contracts").pipe(
      Effect.provide(fixture.layer),
      Effect.provide(FileSystem.layerNoop({
        exists: () => Effect.succeed(true),
        readFileString: () => Effect.succeed(sourceJson),
        remove: () => Effect.void,
        makeDirectory: () => Effect.void,
        copy: () => Effect.sync(() => events.push("stage")),
        writeFileString: () => Effect.void,
        rename: () => Effect.void
      })),
      Effect.provide(Path.layer),
      Effect.flip,
      Effect.tap((error) => Effect.sync(() => {
        expect(error).toEqual(new PublishCommandError({ command: "npm", exitCode: 6 }))
        expect(events).toEqual(expect.arrayContaining(["exit:tsc", "stage", "spawn:npm", "exit:npm"]))
        expect(events.indexOf("exit:tsc")).toBeLessThan(events.indexOf("stage"))
        expect(events.indexOf("stage")).toBeLessThan(events.indexOf("spawn:npm"))
      }))
    )
  })

  it.effect("imports without running the CLI", () =>
    Effect.gen(function*() {
      vi.resetModules()
      const runMain = vi.fn()
      vi.doMock("@effect/platform-node", () => ({
        ...NodePlatform,
        NodeRuntime: { ...NodePlatform.NodeRuntime, runMain }
      }))
      const module = yield* Effect.promise(() => import("../scripts/prepare-publish"))
      expect(module.stage).toBeTypeOf("function")
      expect(runMain).not.toHaveBeenCalled()
      vi.doUnmock("@effect/platform-node")
      vi.resetModules()
    }))
})
