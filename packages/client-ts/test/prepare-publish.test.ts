import * as NodePlatform from "@effect/platform-node"
import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Path, Schema } from "effect"
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
  version: "2.3.4",
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

describe("client publish workflow", () => {
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
      expect(yield* fs.readFileString(path.join(root, "dist-publish", "marker"))).toBe("old")
      expect(yield* fs.exists(path.join(root, ".dist-publish.next"))).toBe(false)
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

      yield* stage(root)

      expect(yield* fs.exists(path.join(root, "dist-publish", "stale"))).toBe(false)
      expect(yield* fs.readFileString(path.join(root, "dist-publish", "dist", "project", "index.d.ts"))).toBe("export {}\n")
      const manifest = yield* fs.readFileString(path.join(root, "dist-publish", "package.json")).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(PublishedManifest)))
      )
      expect(manifest).toEqual({
        name: "@expand/client-ts",
        version: "2.3.4",
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
        dependencies: { effect: "4.0.0-beta.74", "@expand/contracts": "0.0.0" }
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

  it.effect("packs by building, staging, and invoking npm pack in one lazy Effect", () => {
    const fixture = processSpawnerFixture([0, 0, 0])
    const operations: Array<string> = []
    const program = pack("/repo/packages/client-ts").pipe(
      Effect.provide(fixture.layer),
      Effect.provide(FileSystem.layerNoop({
        exists: () => Effect.succeed(true),
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
        .toEqual(["tsup", "tsc", "npm"])
      const npm = fixture.records[2]?.command
      expect(npm?._tag).toBe("StandardCommand")
      if (npm?._tag === "StandardCommand") {
        expect(npm.args).toEqual(["pack", "./dist-publish"])
        expect(npm.options.cwd).toBe("/repo/packages/client-ts")
      }
      expect(operations).toContain("rename:/repo/packages/client-ts/.dist-publish.next:/repo/packages/client-ts/dist-publish")
    })))
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
