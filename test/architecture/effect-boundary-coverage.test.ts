import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Path, Schema } from "effect"
import { describe, expect } from "vitest"
import { runCommand } from "../support/effect-process"

const EslintMessage = Schema.Struct({ ruleId: Schema.NullOr(Schema.String) })
const EslintResult = Schema.Struct({
  filePath: Schema.String,
  messages: Schema.Array(EslintMessage)
})
const EslintJson = Schema.fromJsonString(Schema.Array(EslintResult))

const typescriptFile = (file: string) => /\.(?:ts|tsx|mts|cts)$/.test(file)
const eslintFile = (file: string) => /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(file)

const existingFiles = Effect.fn("EffectBoundaryCoverageTest.existingFiles")(
  function*(root: string, files: ReadonlyArray<string>) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const existing: Array<string> = []
    for (const file of files) if (yield* fs.exists(path.join(root, file))) existing.push(file)
    return existing
  }
)

const repositoryFile = Effect.fn("EffectBoundaryCoverageTest.repositoryFile")(
  function*(root: string, file: string) {
    const path = yield* Path.Path
    const relative = path.relative(root, path.resolve(file)).split(path.sep).join("/")
    return relative !== ".." && !relative.startsWith("../") && !relative.split("/").includes("node_modules")
      ? relative
      : undefined
  }
)

describe("Effect boundary coverage", () => {
  it.live("covers tracked and untracked TypeScript-family files with the workspace project", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      const root = path.resolve(".")
      const manifest = yield* runCommand("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
      const listed = yield* runCommand("tsc", ["--listFilesOnly", "-p", "tsconfig.workspace.json"])
      expect(manifest.exitCode, manifest.stderr).toBe(0)
      expect(listed.exitCode, listed.stderr).toBe(0)
      const expected = (yield* existingFiles(root, manifest.stdout.split("\0").filter(typescriptFile))).sort()
      const actual = (yield* Effect.forEach(
        listed.stdout.split(/\r?\n/).filter(typescriptFile),
        (file) => repositoryFile(root, file)
      )).filter((file): file is string => file !== undefined).sort()

      expect(actual).toEqual(expected)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.live("covers tracked and untracked TS/JS-family files with whole-tree ESLint", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      const root = path.resolve(".")
      const manifest = yield* runCommand("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
      const eslint = yield* runCommand("eslint", ["--config", "eslint.effect.config.mjs", ".", "--format", "json"])
      expect(manifest.exitCode, manifest.stderr).toBe(0)
      expect([0, 1]).toContain(eslint.exitCode)
      const results = yield* Schema.decodeUnknownEffect(EslintJson)(eslint.stdout)
      const expected = (yield* existingFiles(root, manifest.stdout.split("\0").filter(eslintFile))).sort()
      const actual = (yield* Effect.forEach(results, (result) => repositoryFile(root, result.filePath)))
        .filter((file): file is string => file !== undefined && eslintFile(file))
        .sort()

      expect(actual).toEqual(expected)
    }).pipe(Effect.provide(NodeServices.layer)))
})
