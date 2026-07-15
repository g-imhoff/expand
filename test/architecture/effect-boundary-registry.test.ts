import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Path, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { describe, expect } from "vitest"
import { effectHostBoundaries } from "../../eslint-rules/effect-host-boundaries.mjs"
import { type HostBoundary } from "../../scripts/effect-policy-model"
import { isRegisteredNodeBuiltinDiagnostic, validateHostBoundaries } from "../../scripts/effect-audit"

const EslintResult = Schema.Struct({ filePath: Schema.String })
const EslintJson = Schema.fromJsonString(Schema.Array(EslintResult))

const run = Effect.fn("EffectBoundaryRegistryTest.run")(
  (command: string, args: ReadonlyArray<string>, acceptedExitCodes: ReadonlyArray<number>) =>
    Effect.scoped(Effect.gen(function*() {
      const handle = yield* ChildProcess.make(command, args)
      const [stdout, stderr, exitCode] = yield* Effect.all([
        handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
        handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
        handle.exitCode
      ], { concurrency: "unbounded" })
      if (!acceptedExitCodes.includes(exitCode)) return yield* Effect.fail({ command, exitCode, stderr } as const)
      return stdout
    }))
)

const boundary = (overrides: Partial<HostBoundary> = {}): HostBoundary => ({
  file: "src/main.ts",
  declaration: "module:<module>",
  host: "Test entrypoint",
  construct: "runner:NodeRuntime.runMain",
  occurrence: 0,
  ...overrides
}) as HostBoundary

const platformProcessExit = ["platform:process", "exit"].join(".")

type NodeBuiltinDiagnosticMatcherOptions = Parameters<typeof isRegisteredNodeBuiltinDiagnostic>[0]

const nodeHttpBoundary = {
  file: "apps/server/http.ts",
  declaration: "module:<module>",
  construct: ["platform:import:node", "http"].join(":"),
  occurrence: 0
} as const

const nodeHttpOccurrence = (
  overrides: Partial<NodeBuiltinDiagnosticMatcherOptions["occurrences"][number]["identity"]> = {},
  range: ReadonlyArray<number> = [10, 50]
) => ({
  identity: { ...nodeHttpBoundary, ...overrides },
  node: { type: "ImportDeclaration", range }
})

const nodeBuiltinDiagnostic = (
  overrides: Partial<NodeBuiltinDiagnosticMatcherOptions["diagnostic"]> = {}
) => ({ name: "nodeBuiltinImport", start: 25, length: 11, ...overrides })

const withRegistryFixture = Effect.fn("EffectBoundaryRegistryTest.withFixture")(
  function* <A>(
    boundaries: ReadonlyArray<HostBoundary>,
    use: (input: {
      readonly root: string
      readonly trackedFiles: ReadonlyArray<string>
      readonly eslintFiles: ReadonlyArray<string>
      readonly boundaries: ReadonlyArray<HostBoundary>
    }) => Effect.Effect<A, unknown, FileSystem.FileSystem | Path.Path>
  ) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "expand-effect-registry-" })
    const file = "src/main.ts"
    yield* fs.makeDirectory(path.dirname(path.join(root, file)), { recursive: true })
    yield* fs.writeFileString(
      path.join(root, file),
      'import { NodeRuntime } from "@effect/platform-node"\ndeclare const program: never\nNodeRuntime.runMain(program)\n'
    )
    yield* fs.writeFileString(
      path.join(root, "tsconfig.effect-audit.json"),
      '{"compilerOptions":{"strict":true},"include":["**/*.ts"]}'
    )
    return yield* use({ root, trackedFiles: [file], eslintFiles: [file], boundaries })
  }
)

const fixture = <A>(
  boundaries: ReadonlyArray<HostBoundary>,
  use: Parameters<typeof withRegistryFixture<A>>[1]
) => withRegistryFixture(boundaries, use).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

const expectInvalid = (boundaries: ReadonlyArray<HostBoundary>) =>
  fixture(boundaries, (input) =>
    Effect.gen(function*() {
      const error = yield* validateHostBoundaries(input).pipe(Effect.flip)
      expect(error.reason).toBe("invalid-boundary")
    }))

describe("Effect host-boundary registry", () => {
  it("admits the exact registered Node builtin import occurrence", () => {
    expect(isRegisteredNodeBuiltinDiagnostic({
      file: nodeHttpBoundary.file,
      diagnostic: nodeBuiltinDiagnostic(),
      occurrences: [nodeHttpOccurrence()],
      boundaries: [nodeHttpBoundary]
    })).toBe(true)
  })

  it.each([
    ["unregistered file", { file: "src/http.ts" }],
    ["wrong declaration", { occurrences: [nodeHttpOccurrence({ declaration: "variable:server" })] }],
    ["wrong construct", { occurrences: [nodeHttpOccurrence({ construct: ["platform:import:node", "fs"].join(":") })] }],
    ["wrong occurrence", { occurrences: [nodeHttpOccurrence({ occurrence: 1 })] }],
    ["ambiguous occurrence", { occurrences: [nodeHttpOccurrence(), nodeHttpOccurrence()] }],
    ["non-containing range", { diagnostic: nodeBuiltinDiagnostic({ start: 55 }) }],
    ["missing diagnostic length", { diagnostic: nodeBuiltinDiagnostic({ length: undefined }) }],
    ["different diagnostic name", { diagnostic: nodeBuiltinDiagnostic({ name: "processEnv" }) }]
  ])("keeps %s blocking", (_name, overrides) => {
    expect(isRegisteredNodeBuiltinDiagnostic({
      file: nodeHttpBoundary.file,
      diagnostic: nodeBuiltinDiagnostic(),
      occurrences: [nodeHttpOccurrence()],
      boundaries: [nodeHttpBoundary],
      ...overrides
    })).toBe(false)
  })

  it.effect("accepts one exact tracked and consumed boundary", () =>
    fixture([boundary()], (input) => validateHostBoundaries(input)))

  it.effect("resolves every permanent boundary against tracked AST and ESLint consumers", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      const root = path.resolve(".")
      const tracked = (yield* run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], [0]))
        .split("\0")
        .filter(Boolean)
      const eslint = yield* run("eslint", ["--config", "eslint.effect.config.mjs", ".", "--format", "json"], [0, 1])
      const eslintFiles = (yield* Schema.decodeUnknownEffect(EslintJson)(eslint)).map((result) =>
        path.relative(root, path.resolve(result.filePath)).split(path.sep).join("/")
      )

      yield* validateHostBoundaries({ root, trackedFiles: tracked, eslintFiles, boundaries: effectHostBoundaries })
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects broad paths and empty identity fields", () =>
    expectInvalid([boundary({ file: "src/*.ts" })]).pipe(
      Effect.andThen(expectInvalid([boundary({ host: "*" })])),
      Effect.andThen(expectInvalid([boundary({ declaration: "" })])),
      Effect.andThen(expectInvalid([boundary({ host: "   " })])),
      Effect.andThen(expectInvalid([boundary({ construct: "" })]))
    ))

  it.effect("rejects records whose file is missing from the tracked manifest", () =>
    expectInvalid([boundary({ file: "src/missing.ts" })]))

  it.effect("rejects duplicate records", () =>
    expectInvalid([boundary(), boundary()]))

  it.effect("rejects multiple records matching one source occurrence", () =>
    expectInvalid([boundary({ host: "First host" }), boundary({ host: "Second host" })]))

  it.effect("rejects unconsumed occurrence identities", () =>
    expectInvalid([boundary({ occurrence: 1 })]))

  it.effect("rejects a stale process exit boundary after the source call is removed", () =>
    expectInvalid([boundary({ construct: platformProcessExit })]))

  it.effect("rejects boundaries without an ESLint consumer", () =>
    fixture([boundary()], (input) =>
      Effect.gen(function*() {
        const error = yield* validateHostBoundaries({ ...input, eslintFiles: [] }).pipe(Effect.flip)
        expect(error.reason).toBe("invalid-boundary")
      })))
})
