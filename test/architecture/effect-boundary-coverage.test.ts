import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { describe, expect } from "vitest"

const EslintOutputJson = Schema.fromJsonString(Schema.Array(Schema.Struct({
  filePath: Schema.String
})))

const sourceExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]
const typeScriptExtensions = [".ts", ".tsx", ".mts", ".cts"]

const runText = Effect.fn("EffectBoundaryCoverageTest.runText")(
  (root: string, command: string, args: ReadonlyArray<string>, accepted: ReadonlyArray<number>) =>
    Effect.scoped(Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const handle = yield* spawner.spawn(ChildProcess.make(command, args, { cwd: root }))
      const [stdout, stderr, exitCode] = yield* Effect.all([
        handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
        handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
        handle.exitCode
      ], { concurrency: "unbounded" })
      const numericExit = Number(exitCode)
      if (!accepted.includes(numericExit)) {
        return yield* Effect.fail({ command, args, exitCode: numericExit, stderr } as const)
      }
      return stdout
    }))
)

const normalize = Effect.fn("EffectBoundaryCoverageTest.normalize")(
  function*(root: string, files: ReadonlyArray<string>) {
    const path = yield* Path.Path
    return Array.from(new Set(files.map((file) =>
      path.relative(root, path.resolve(root, file)).split(path.sep).join("/")
    ))).sort()
  }
)

const repositoryRoot = Effect.fn("EffectBoundaryCoverageTest.repositoryRoot")(
  function*() {
    const path = yield* Path.Path
    return yield* path.fromFileUrl(new URL("../../", import.meta.url))
  }
)()

const manifest = Effect.fn("EffectBoundaryCoverageTest.manifest")(
  function*(root: string) {
    const output = yield* runText(root, "git", [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z"
    ], [0])
    return yield* normalize(root, output.split("\0").filter((file) => file.length > 0))
  }
)

const hasExtension = (file: string, extensions: ReadonlyArray<string>) =>
  extensions.some((extension) => file.endsWith(extension))

describe("Effect boundary engine coverage", () => {
  it.effect("includes every non-ignored TypeScript-family source in the audit project", () =>
    Effect.gen(function*() {
      const root = yield* repositoryRoot
      const expected = (yield* manifest(root)).filter((file) => hasExtension(file, typeScriptExtensions))
      const output = yield* runText(root, "npm", [
        "exec",
        "--",
        "tsc",
        "--listFilesOnly",
        "-p",
        "tsconfig.effect-audit.json"
      ], [0])
      const path = yield* Path.Path
      const actual = yield* normalize(root, output.split(/\r?\n/u).filter((file) => {
        if (!hasExtension(file, typeScriptExtensions)) return false
        const relative = path.relative(root, path.resolve(root, file))
        return relative !== ".."
          && !relative.startsWith(`..${path.sep}`)
          && !relative.split(path.sep).includes("node_modules")
      }))
      expect(actual).toEqual(expected)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("includes every non-ignored TypeScript and JavaScript source in whole-tree ESLint", () =>
    Effect.gen(function*() {
      const root = yield* repositoryRoot
      const expected = (yield* manifest(root)).filter((file) => hasExtension(file, sourceExtensions))
      const output = yield* runText(root, "npm", [
        "exec",
        "--",
        "eslint",
        "--config",
        "eslint.effect.config.mjs",
        ".",
        "--format",
        "json"
      ], [0, 1])
      const decoded = yield* Schema.decodeUnknownEffect(EslintOutputJson)(output)
      const expectedSet = new Set(expected)
      const actual = (yield* normalize(root, decoded.map((result) => result.filePath)))
        .filter((file) => expectedSet.has(file))
      expect(actual).toEqual(expected)
    }).pipe(Effect.provide(NodeServices.layer)), 120_000)
})
