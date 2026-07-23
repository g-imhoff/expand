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
    const fixture = processSpawnerFixture([0, 0])
    const operations: Array<string> = []
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
      expect(operations).toContain("rename:/repo/packages/contracts/.dist-publish.next:/repo/packages/contracts/dist-publish")
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
