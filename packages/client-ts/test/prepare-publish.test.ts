import * as NodePlatform from "@effect/platform-node"
import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Layer, Cause, Deferred, Effect, Exit, Fiber, FileSystem, Path, Schema } from "effect"
import { describe, expect, vi } from "vitest"
import { processSpawnerFixture } from "../../../test/support/process-spawner"
import {
  PublishCommandError,
  PublishManifestError,
  PublishStageError,
  build,
  pack,
  releaseAtRoot,
  stage
} from "../scripts/prepare-publish"

const SourceManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  private: Schema.Boolean,
  type: Schema.Literal("module"),
  sideEffects: Schema.Boolean,
  exports: Schema.Unknown,
  dependencies: Schema.Record(Schema.String, Schema.String)
})

const PublishedManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  private: Schema.Boolean,
  type: Schema.Literal("module"),
  sideEffects: Schema.Boolean,
  exports: Schema.Unknown,
  files: Schema.Array(Schema.String),
  dependencies: Schema.Record(Schema.String, Schema.String)
})

const sourceManifest = {
  name: "@expand/client-ts",
  version: "0.0.0",
  private: true,
  type: "module" as const,
  sideEffects: false,
  exports: { ".": "./index.ts" },
  dependencies: { effect: "4.0.0-beta.74", "@expand/contracts": "0.0.0" }
}

const sourceJson = Schema.encodeSync(Schema.fromJsonString(SourceManifest))(sourceManifest)

const withFixture = Effect.fn("ClientPublishTest.withFixture")(
  function*<A, E, R>(use: (root: string) => Effect.Effect<A, E, R>) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "expand-client-publish-" })
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

describe("client publish workflow", () => {
  it.live("fails when dist is missing without replacing an existing stage", () =>
    live(withFixture((root) => Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.makeDirectory(path.join(root, "dist-publish"))
      yield* fs.writeFileString(path.join(root, "dist-publish", "marker"), "old")

      const error = yield* stage(root, "4.5.6").pipe(Effect.flip)

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

      const error = yield* stage(root, "4.5.6").pipe(
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

      const error = yield* stage(root, "4.5.6").pipe(Effect.flip)

      expect(error).toBeInstanceOf(PublishManifestError)
      expect(error).not.toBeInstanceOf(PublishStageError)
      expect(yield* fs.readFileString(path.join(root, "dist-publish", "marker"))).toBe("old")
      expect(yield* fs.exists(path.join(root, ".dist-publish.next"))).toBe(false)
    }))))

  it.live("does not promote a stale backup when stale cleanup fails before mutation", () =>
    live(withFixture((root) => Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const failure = { reason: "stale previous cleanup" }
      const renames: Array<readonly [string, string]> = []
      yield* fs.makeDirectory(path.join(root, "dist"))
      yield* fs.writeFileString(path.join(root, "dist", "index.js"), "new bytes")
      yield* fs.makeDirectory(path.join(root, "dist-publish"))
      yield* fs.writeFileString(path.join(root, "dist-publish", "marker"), "exact target bytes")
      yield* fs.makeDirectory(path.join(root, ".dist-publish.previous"))
      yield* fs.writeFileString(path.join(root, ".dist-publish.previous", "marker"), "exact stale bytes")

      const exit = yield* stage(root, "4.5.6").pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          remove: (target, options) => target === path.join(root, ".dist-publish.previous")
            ? Effect.fail(failure as never)
            : fs.remove(target, options),
          rename: (from, to) => Effect.sync(() => renames.push([from, to] as const)).pipe(
            Effect.andThen(fs.rename(from, to))
          )
        }),
        Effect.exit
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const errors = exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)
        expect(errors).toContainEqual(new PublishStageError({ operation: "clean", cause: failure }))
      }
      expect(yield* fs.readFileString(path.join(root, "dist-publish", "marker"))).toBe("exact target bytes")
      expect(yield* fs.readFileString(path.join(root, ".dist-publish.previous", "marker"))).toBe("exact stale bytes")
      expect(renames).toEqual([])
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

          const error = yield* stage(root, "4.5.6").pipe(
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

          yield* stage(root, "4.5.6").pipe(
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

  it.live("preserves absent output across an interrupted write mutation barrier", () =>
    live(withFixture((root) => Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const written = yield* Deferred.make<void>()
      yield* fs.makeDirectory(path.join(root, "dist"))
      yield* fs.writeFileString(path.join(root, "dist", "index.js"), "new bytes")
      yield* fs.makeDirectory(path.join(root, ".dist-publish.previous"))
      yield* fs.writeFileString(path.join(root, ".dist-publish.previous", "stale"), "stale previous")
      const fiber = yield* stage(root, "4.5.6").pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          writeFileString: (target, value, options) => fs.writeFileString(target, value, options).pipe(
            Effect.andThen(target.endsWith(".dist-publish.next/package.json")
              ? Deferred.succeed(written, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.void)
          )
        }),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred["a\u0077ait"](written)
      yield* Fiber.interrupt(fiber)
      expect(yield* fs.exists(path.join(root, "dist-publish"))).toBe(false)
      yield* expectNoTransactionArtifacts(fs, path, root)
    }))))

  it.live("combines a primary mutation failure with cleanup failures", () =>
    live(withFixture((root) => Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const primary = { reason: "copy" }
      const cleanup = { reason: "cleanup" }
      let copied = false
      yield* fs.makeDirectory(path.join(root, "dist"))
      yield* fs.writeFileString(path.join(root, "dist", "index.js"), "new bytes")
      const exit = yield* stage(root, "4.5.6").pipe(
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

  it.live("recursively stages dist, cleans stale output, and writes only the public entrypoint exports", () =>
    live(withFixture((root) => Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.makeDirectory(path.join(root, "dist", "project"), { recursive: true })
      yield* fs.writeFileString(path.join(root, "dist", "index.js"), "export {}\n")
      yield* fs.writeFileString(path.join(root, "dist", "project", "index.d.ts"), "export {}\n")
      yield* fs.makeDirectory(path.join(root, "dist-publish"))
      yield* fs.writeFileString(path.join(root, "dist-publish", "stale"), "remove")

      yield* stage(root, "4.5.6")

      expect(yield* fs.exists(path.join(root, "dist-publish", "stale"))).toBe(false)
      expect(yield* fs.readFileString(path.join(root, "dist-publish", "dist", "project", "index.d.ts"))).toBe("export {}\n")
      const manifest = yield* fs.readFileString(path.join(root, "dist-publish", "package.json")).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(PublishedManifest)))
      )
      expect(manifest).toEqual({
        name: "@expand/client-ts",
        version: "4.5.6",
        type: "module",
        sideEffects: false,
        private: false,
        exports: {
          ".": {
            types: "./dist/index.d.ts",
            import: "./dist/index.js",
            default: "./dist/index.js"
          },
          "./project": {
            types: "./dist/project/index.d.ts",
            import: "./dist/project/index.js",
            default: "./dist/project/index.js"
          },
          "./server": {
            types: "./dist/server/index.d.ts",
            import: "./dist/server/index.js",
            default: "./dist/server/index.js"
          },
          "./adapters/node": {
            types: "./dist/adapters/node.d.ts",
            import: "./dist/adapters/node.js",
            default: "./dist/adapters/node.js"
          },
          "./package.json": "./package.json"
        },
        files: ["dist"],
        dependencies: { effect: "4.0.0-beta.74", "@expand/contracts": "4.5.6" }
      })
    }))))

  it.effect("runs both scoped build commands and stops on a tagged nonzero exit", () => {
    const fixture = processSpawnerFixture([0, 7])
    return build("/repo/packages/client-ts").pipe(
      Effect.provide(fixture.layer),
      Effect.flip,
      Effect.tap((error) => Effect.sync(() => {
        expect(error).toEqual(new PublishCommandError({ command: "tsc", exitCode: 7 }))
        expect(fixture.records.map((record) => record.command._tag === "StandardCommand" ? record.command.command : "pipe"))
          .toEqual(["tsup", "tsc"])
        expect(fixture.records.every((record) => record.released)).toBe(true)
      }))
    )
  })

  it.effect("rejects the stage command path when HEAD has no exact release tag", () => {
    const fixture = processSpawnerFixture([0, 0])
    return releaseAtRoot(stage).pipe(
      Effect.provide(Layer.mergeAll(fixture.layer, Path.layer, FileSystem.layerNoop({}))),
      Effect.flip,
      Effect.map((error) => expect(error).toMatchObject({ _tag: "AppVersionError", reason: "missing-release-tag" }))
    )
  })

  it.effect("packs by building, staging, and invoking npm pack in one lazy Effect", () => {
    const operations: Array<string> = []
    const fixture = processSpawnerFixture([0, 0, 0], { eventLog: operations })
    const program = pack("/repo/packages/client-ts", "4.5.6").pipe(
      Effect.provide(Layer.mergeAll(fixture.layer, FileSystem.layerNoop({
        exists: () => Effect.succeed(true),
        readFileString: () => Effect.succeed(sourceJson),
        remove: (target) => Effect.sync(() => operations.push(`remove:${target}`)),
        makeDirectory: (target) => Effect.sync(() => operations.push(`mkdir:${target}`)),
        copy: (from, to) => Effect.sync(() => operations.push(`copy:${from}:${to}`)),
        writeFileString: (target) => Effect.sync(() => operations.push(`write:${target}`)),
        rename: (from, to) => Effect.sync(() => operations.push(`rename:${from}:${to}`))
      }), Path.layer))
    )

    expect(Effect.isEffect(program)).toBe(true)
    expect(fixture.records).toHaveLength(0)

    return program.pipe(Effect.tap(() => Effect.sync(() => {
      expect(fixture.records.map((record) => record.command._tag === "StandardCommand" ? record.command.command : "pipe"))
        .toEqual(["tsup", "tsc", "npm"])
      const npm = fixture.records[2]?.command
      expect(npm?._tag).toBe("StandardCommand")
      if (npm?._tag === "StandardCommand") {
        expect(npm.args).toEqual(["pack", "./dist-publish"])
        expect(npm.options.cwd).toBe("/repo/packages/client-ts")
      }
      expect(operations.indexOf("exit:tsc")).toBeLessThan(operations.indexOf("copy:/repo/packages/client-ts/dist:/repo/packages/client-ts/.dist-publish.next/dist"))
      expect(operations.indexOf("rename:/repo/packages/client-ts/.dist-publish.next:/repo/packages/client-ts/dist-publish")).toBeLessThan(operations.indexOf("spawn:npm"))
    })))
  })

  it.effect("returns the exact tagged npm pack nonzero failure after both builds and stage", () => {
    const events: Array<string> = []
    const fixture = processSpawnerFixture([0, 0, 8], { eventLog: events })
    return pack("/repo/packages/client-ts", "4.5.6").pipe(
      Effect.provide(Layer.mergeAll(fixture.layer, FileSystem.layerNoop({
        exists: () => Effect.succeed(true),
        readFileString: () => Effect.succeed(sourceJson),
        remove: () => Effect.void,
        makeDirectory: () => Effect.void,
        copy: () => Effect.sync(() => events.push("stage")),
        writeFileString: () => Effect.void,
        rename: () => Effect.void
      }), Path.layer)),
      Effect.flip,
      Effect.tap((error) => Effect.sync(() => {
        expect(error).toEqual(new PublishCommandError({ command: "npm", exitCode: 8 }))
        expect(events).toEqual(expect.arrayContaining(["exit:tsup", "exit:tsc", "stage", "spawn:npm", "exit:npm"]))
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
