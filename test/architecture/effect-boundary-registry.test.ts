import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { describe, expect } from "vitest"
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
})
