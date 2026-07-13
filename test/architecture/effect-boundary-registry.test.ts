import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Linter } from "eslint"
import { Effect, FileSystem, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { describe, expect, vi } from "vitest"
import { effectHostBoundaries } from "../../eslint-rules/effect-host-boundaries.mjs"
import { validateHostBoundaries } from "../../scripts/effect-audit"
import { HostBoundary } from "../../scripts/effect-policy-model"

const hostSource = [
  "import { NodeRuntime } from \"@effect/platform-node\"",
  "declare const program: never",
  "NodeRuntime.runMain(program)",
  ""
].join("\n")

const runText = Effect.fn("EffectBoundaryRegistryTest.runText")(
  (root: string, command: string, args: ReadonlyArray<string>) =>
    Effect.scoped(Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const handle = yield* spawner.spawn(ChildProcess.make(command, args, { cwd: root }))
      const [stdout, stderr, exitCode] = yield* Effect.all([
        handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
        handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
        handle.exitCode
      ], { concurrency: "unbounded" })
      if (Number(exitCode) !== 0) {
        return yield* Effect.fail({ command, args, exitCode: Number(exitCode), stderr } as const)
      }
      return stdout
    }))
)

const repositoryRoot = Effect.fn("EffectBoundaryRegistryTest.repositoryRoot")(
  function*() {
    const path = yield* Path.Path
    return yield* path.fromFileUrl(new URL("../../", import.meta.url))
  }
)()

const makeBoundary = (overrides: Partial<HostBoundary> = {}) => new HostBoundary({
  file: "src/host.ts",
  declaration: "module:<module>",
  host: "Test host",
  construct: "runner:NodeRuntime.runMain",
  occurrence: 0,
  ...overrides
})

const makeFixture = Effect.fn("EffectBoundaryRegistryTest.makeFixture")(
  function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "effect-boundary-registry-" })
    yield* fs.makeDirectory(path.join(root, "src"), { recursive: true })
    yield* fs.writeFileString(path.join(root, "src/host.ts"), hostSource)
    yield* fs.writeFileString(
      path.join(root, "tsconfig.effect-audit.json"),
      "{\"compilerOptions\":{\"target\":\"ESNext\",\"module\":\"NodeNext\",\"moduleResolution\":\"NodeNext\"},\"include\":[\"**/*.ts\"]}\n"
    )
    return { root, indexedFiles: ["src/host.ts"], eslintFiles: ["src/host.ts"] }
  }
)

const makeParserFixture = Effect.fn("EffectBoundaryRegistryTest.makeParserFixture")(
  function*(file: string, source: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "effect-boundary-parser-" })
    yield* fs.makeDirectory(path.join(root, path.dirname(file)), { recursive: true })
    yield* fs.writeFileString(path.join(root, file), source)
    return { root, indexedFiles: [file], eslintFiles: [file] }
  }
)

const invalidBoundary = Effect.fn("EffectBoundaryRegistryTest.invalidBoundary")(
  function*(input: {
    readonly root: string
    readonly boundaries: ReadonlyArray<HostBoundary>
    readonly indexedFiles: ReadonlyArray<string>
    readonly eslintFiles: ReadonlyArray<string>
  }) {
    const error = yield* validateHostBoundaries(input).pipe(Effect.flip)
    expect(error.reason).toBe("invalid-boundary")
    expect(error.findings).toEqual([])
    expect(error.detail?.split("\n").filter((line) => line.length > 0)).toHaveLength(1)
    return error
  }
)

describe("Effect host boundary registry", () => {
  it.effect("resolves every configured boundary to one indexed source and ESLint consumer", () =>
    Effect.gen(function*() {
      const root = yield* repositoryRoot
      const output = yield* runText(root, "git", [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z"
      ])
      const files = output.split("\0").filter((file) => file.length > 0)
      yield* validateHostBoundaries({
        root,
        boundaries: effectHostBoundaries,
        indexedFiles: files,
        eslintFiles: files
      })
      expect(effectHostBoundaries).toHaveLength(3)
      expect(effectHostBoundaries.at(-1)).toEqual({
        file: "scripts/effect-audit.ts",
        declaration: "module:<module>",
        host: "Node audit entrypoint",
        construct: "runner:NodeRuntime.runMain",
        occurrence: 0
      })
      expect(Object.isFrozen(effectHostBoundaries)).toBe(true)
      expect(effectHostBoundaries.every(Object.isFrozen)).toBe(true)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects broad required text once", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      yield* invalidBoundary({ ...fixture, boundaries: [makeBoundary({ file: "src/*.ts" })] })
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects empty required text once", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      yield* invalidBoundary({ ...fixture, boundaries: [makeBoundary({ host: "" })] })
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects a non-string boundary file without defecting", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      const boundary = makeBoundary()
      expect(Reflect.set(boundary, "file", null)).toBe(true)
      const error = yield* invalidBoundary({ ...fixture, boundaries: [boundary] })
      expect(error.detail).toBe("invalid boundary record 0")
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects a missing indexed file once", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      yield* invalidBoundary({ ...fixture, boundaries: [makeBoundary({ file: "src/missing.ts" })] })
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects duplicate permanent records once for the repository", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      const boundary = makeBoundary()
      const error = yield* invalidBoundary({
        ...fixture,
        boundaries: [boundary, boundary],
        eslintFiles: ["src/host.ts", "src/host.ts", "src/host.ts"]
      })
      expect(error.detail).toContain("duplicate")
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects non-canonical boundary aliases before duplicate resolution", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      for (const file of ["./src/host.ts", "src/nested/../host.ts"]) {
        const error = yield* invalidBoundary({
          ...fixture,
          boundaries: [makeBoundary(), makeBoundary({ file })]
        })
        expect(error.detail).toBe("invalid boundary record 1")
      }
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects multiple normalized index matches once", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      yield* invalidBoundary({
        ...fixture,
        boundaries: [makeBoundary()],
        indexedFiles: ["src/host.ts", "./src/host.ts"]
      })
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects an unconsumed construct occurrence once", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      yield* invalidBoundary({
        ...fixture,
        boundaries: [makeBoundary({ occurrence: 1 })]
      })
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects a boundary without an ESLint consumer once", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      yield* invalidBoundary({
        ...fixture,
        boundaries: [makeBoundary()],
        eslintFiles: []
      })
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects multiple normalized ESLint consumers once", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      const error = yield* invalidBoundary({
        ...fixture,
        boundaries: [makeBoundary()],
        eslintFiles: ["src/host.ts", "./src/host.ts"]
      })
      expect(error.detail).toContain("ESLint consumer")
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects a fatal parser diagnostic once", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture()
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(path.join(fixture.root, "src/host.ts"), "const =\n")
      const error = yield* invalidBoundary({ ...fixture, boundaries: [makeBoundary()] })
      expect(error.detail).toContain("fatal parser diagnostic")
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("mirrors ESLint parser configuration for CJS and JavaScript JSX", () => {
    const verify = vi.spyOn(Linter.prototype, "verify")
    return Effect.gen(function*() {
      const cases = [{
        file: "src/host.cjs",
        source: "async function load() {}\n",
        sourceType: "commonjs"
      }, {
        file: "src/view.js",
        source: "async function load() {}\nconst view = <div />\n",
        sourceType: "module"
      }] as const
      for (const testCase of cases) {
        const fixture = yield* makeParserFixture(testCase.file, testCase.source)
        yield* validateHostBoundaries({
          ...fixture,
          boundaries: [makeBoundary({
            file: testCase.file,
            declaration: "function:load",
            construct: "native:async"
          })]
        })
      }
      expect(verify).toHaveBeenCalledTimes(2)
      for (const [index, testCase] of cases.entries()) {
        expect(verify.mock.calls[index]?.[1]).toMatchObject({
          languageOptions: {
            parserOptions: { ecmaFeatures: { jsx: true } },
            sourceType: testCase.sourceType
          }
        })
      }
    }).pipe(
      Effect.ensuring(Effect.sync(() => verify.mockRestore())),
      Effect.provide(NodeServices.layer)
    )
  })
})
