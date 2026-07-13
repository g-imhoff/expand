import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, Path, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { describe, expect } from "vitest"

const EslintMessage = Schema.Struct({ ruleId: Schema.NullOr(Schema.String) })
const EslintResult = Schema.Struct({
  filePath: Schema.String,
  messages: Schema.Array(EslintMessage)
})
const EslintJson = Schema.fromJsonString(Schema.Array(EslintResult))

const run = Effect.fn("EffectBoundaryCoverageTest.run")(
  (command: string, args: ReadonlyArray<string>, acceptedExitCodes: ReadonlyArray<number>) =>
    Effect.scoped(Effect.gen(function*() {
      const handle = yield* ChildProcess.make(command, args)
      const [stdout, stderr, exitCode] = yield* Effect.all([
        handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
        handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
        handle.exitCode
      ], { concurrency: "unbounded" })
      if (!acceptedExitCodes.includes(exitCode)) {
        return yield* Effect.fail({ command, exitCode, stderr } as const)
      }
      return stdout
    }))
)

const typescriptFile = (file: string) => /\.(?:ts|tsx|mts|cts)$/.test(file)
const eslintFile = (file: string) => /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(file)

const repositoryFile = Effect.fn("EffectBoundaryCoverageTest.repositoryFile")(
  function*(root: string, file: string) {
    const path = yield* Path.Path
    const relative = path.relative(root, path.resolve(file)).split(path.sep).join("/")
    return relative !== ".." && !relative.startsWith("../") && !relative.split("/").includes("node_modules")
      ? relative
      : undefined
  }
)

describe("Effect audit boundary coverage", () => {
  it.effect("covers tracked and untracked TypeScript-family files with the audit project", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      const root = path.resolve(".")
      const manifest = yield* run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], [0])
      const listed = yield* run("tsc", ["--listFilesOnly", "-p", "tsconfig.effect-audit.json"], [0])
      const expected = manifest.split("\0").filter(typescriptFile).sort()
      const actual = (yield* Effect.forEach(
        listed.split(/\r?\n/).filter(typescriptFile),
        (file) => repositoryFile(root, file)
      )).filter((file): file is string => file !== undefined).sort()

      expect(actual).toEqual(expected)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("covers tracked and untracked TS/JS-family files with whole-tree ESLint", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      const root = path.resolve(".")
      const manifest = yield* run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], [0])
      const eslint = yield* run("eslint", ["--config", "eslint.effect.config.mjs", ".", "--format", "json"], [0, 1])
      const results = yield* Schema.decodeUnknownEffect(EslintJson)(eslint)
      const expected = manifest.split("\0").filter(eslintFile).sort()
      const actual = (yield* Effect.forEach(results, (result) => repositoryFile(root, result.filePath)))
        .filter((file): file is string => file !== undefined && eslintFile(file))
        .sort()

      expect(actual).toEqual(expected)
    }).pipe(Effect.provide(NodeServices.layer)))
})
