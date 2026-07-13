import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, Exit, FileSystem, Layer, Path, Schema } from "effect"
import { describe, expect } from "vitest"
import { effectHostBoundaries } from "../eslint-rules/effect-host-boundaries.mjs"
import {
  AuditCommandRunner,
  AuditCommandRunnerLive,
  type AuditCommandRequest,
  type AuditCommandResult,
  runAudit
} from "./effect-audit"
import {
  AuditBaselineJson,
  AuditFinding,
  EffectAuditError,
  canUpdateBaseline,
  compareAudit,
  findingKey
} from "./effect-audit-model"
import { HostBoundary, NonNegativeInt, PositiveInt, SourceIdentity } from "./effect-policy-model"

const LanguageDiagnostic = Schema.Struct({
  file: Schema.String,
  start: Schema.Int,
  length: Schema.Int,
  line: PositiveInt,
  column: PositiveInt,
  endLine: PositiveInt,
  endColumn: PositiveInt,
  severity: Schema.Literals(["error", "message"]),
  code: Schema.Int,
  name: Schema.String,
  message: Schema.String
})
const LanguageOutputJson = Schema.fromJsonString(Schema.Struct({
  diagnostics: Schema.Array(LanguageDiagnostic),
  summary: Schema.Struct({
    filesChecked: NonNegativeInt,
    totalFiles: NonNegativeInt,
    errors: NonNegativeInt,
    warnings: NonNegativeInt,
    messages: NonNegativeInt
  })
}))
const EslintMessage = Schema.Struct({
  ruleId: Schema.NullOr(Schema.String),
  severity: Schema.Literals([1, 2]),
  message: Schema.String,
  messageId: Schema.optionalKey(Schema.String),
  fatal: Schema.optionalKey(Schema.Boolean),
  line: Schema.optionalKey(PositiveInt),
  column: Schema.optionalKey(PositiveInt),
  endLine: Schema.optionalKey(PositiveInt),
  endColumn: Schema.optionalKey(PositiveInt)
})
const EslintOutputJson = Schema.fromJsonString(Schema.Array(Schema.Struct({
  filePath: Schema.String,
  messages: Schema.Array(EslintMessage)
})))
type EslintResult = Schema.Schema.Type<typeof EslintOutputJson>[number]
const PackageJson = Schema.fromJsonString(Schema.Struct({
  scripts: Schema.Record(Schema.String, Schema.String)
}))

const asyncLanguageFinding = new AuditFinding({
  engine: "effect-language-service",
  file: "src/main.ts",
  rule: "asyncFunction",
  declaration: "function:load",
  construct: "native:async",
  occurrence: 0,
  severity: "error",
  line: 99,
  excerpt: "display data from an earlier revision"
})

const asyncEslintFinding = new AuditFinding({
  engine: "eslint",
  file: "src/main.ts",
  rule: "nativeAsync",
  declaration: "function:load",
  construct: "native:async",
  occurrence: 0,
  severity: "error"
})

const makeFinding = (overrides: Partial<AuditFinding> = {}) => new AuditFinding({
  engine: "eslint",
  file: "src/a.ts",
  rule: "nativeAwait",
  declaration: "function:load",
  construct: "native:await",
  occurrence: 0,
  severity: "error",
  ...overrides
})

const commandOrder: ReadonlyArray<AuditCommandRequest["name"]> = [
  "language-service",
  "eslint",
  "typescript-files",
  "tracked-files",
  "tracked-modes"
]

type CommandResponses = Record<AuditCommandRequest["name"], AuditCommandResult>

interface FixtureOptions {
  readonly baseline?: ReadonlyArray<AuditFinding> | null
  readonly languageDiagnostics?: ReadonlyArray<Schema.Schema.Type<typeof LanguageDiagnostic>>
    | ((root: string) => ReadonlyArray<Schema.Schema.Type<typeof LanguageDiagnostic>>)
  readonly eslintMessages?: ReadonlyArray<Schema.Schema.Type<typeof EslintMessage>>
  readonly extraEslintResults?: (root: string) => ReadonlyArray<EslintResult>
  readonly omitTypeScriptFile?: string
  readonly omitEslintFile?: string
  readonly responseOverrides?: Partial<CommandResponses>
}

const makeRunnerLayer = (
  responses: CommandResponses,
  requests: Array<AuditCommandRequest>,
  failure?: { readonly name: AuditCommandRequest["name"]; readonly error: EffectAuditError }
) => Layer.succeed(AuditCommandRunner, {
  run: (request) => Effect.sync(() => {
    requests.push(request)
    return request
  }).pipe(
    Effect.flatMap((current) => failure?.name === current.name
      ? Effect.fail(failure.error)
      : Effect.succeed(responses[current.name]))
  )
})

const hostSource = [
  "import { NodeRuntime } from \"@effect/platform-node\"",
  "import { Effect } from \"effect\"",
  "NodeRuntime.runMain(Effect.void)",
  ""
].join("\n")

const mainFile = "src/main.ts"
const cleanJavaScriptFile = "src/clean.js"
const typeScriptFile = /\.(?:ts|tsx|mts|cts)$/u

const makeFixture = Effect.fn("EffectAuditTest.makeFixture")(
  function*(options: FixtureOptions = {}) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "effect-audit-" })
    const indexedFiles = Array.from(new Set([
      mainFile,
      cleanJavaScriptFile,
      ...effectHostBoundaries.map((boundary) => boundary.file)
    ])).sort()

    yield* fs.makeDirectory(path.join(root, "src"), { recursive: true })
    yield* fs.writeFileString(path.join(root, mainFile), "export async function load() { return 1 }\n")
    yield* fs.writeFileString(path.join(root, cleanJavaScriptFile), "export const clean = 1\n")
    yield* fs.writeFileString(
      path.join(root, "tsconfig.effect-audit.json"),
      "{\"compilerOptions\":{\"target\":\"ESNext\",\"module\":\"NodeNext\",\"moduleResolution\":\"NodeNext\"},\"include\":[\"**/*.ts\"]}\n"
    )
    for (const boundary of effectHostBoundaries) {
      const target = path.join(root, boundary.file)
      yield* fs.makeDirectory(path.dirname(target), { recursive: true })
      yield* fs.writeFileString(target, hostSource)
    }

    const languageDiagnostics = typeof options.languageDiagnostics === "function"
      ? options.languageDiagnostics(root)
      : options.languageDiagnostics ?? []
    const indexedTypeScriptFiles = indexedFiles.filter((file) => typeScriptFile.test(file))
    const languageOutput = yield* Schema.encodeEffect(LanguageOutputJson)({
      diagnostics: languageDiagnostics,
      summary: {
        filesChecked: indexedTypeScriptFiles.length,
        totalFiles: indexedTypeScriptFiles.length,
        errors: languageDiagnostics.filter((diagnostic) => diagnostic.severity === "error").length,
        warnings: 0,
        messages: languageDiagnostics.filter((diagnostic) => diagnostic.severity === "message").length
      }
    })
    const eslintResults = [...indexedFiles
      .filter((file) => file !== options.omitEslintFile)
      .map((file) => ({
        filePath: path.join(root, file),
        messages: file === mainFile ? [...(options.eslintMessages ?? [])] : []
      })),
    ...(options.extraEslintResults?.(root) ?? [])]
    const eslintOutput = yield* Schema.encodeEffect(EslintOutputJson)(eslintResults)
    const typeScriptFiles = indexedTypeScriptFiles
      .filter((file) => file !== options.omitTypeScriptFile)
      .map((file) => path.join(root, file))
      .join("\n") + "\n"
    const trackedFiles = `${indexedFiles.join("\0")}\0`
    const trackedModes = `${indexedFiles
      .map((file) => `100644 0000000000000000000000000000000000000000 0\t${file}`)
      .join("\0")}\0`
    const responses: CommandResponses = {
      "language-service": { exitCode: languageDiagnostics.length === 0 ? 0 : 1, stdout: languageOutput, stderr: "" },
      eslint: {
        exitCode: eslintResults.some((result) => result.messages.length > 0) ? 1 : 0,
        stdout: eslintOutput,
        stderr: ""
      },
      "typescript-files": { exitCode: 0, stdout: typeScriptFiles, stderr: "" },
      "tracked-files": { exitCode: 0, stdout: trackedFiles, stderr: "" },
      "tracked-modes": { exitCode: 0, stdout: trackedModes, stderr: "" },
      ...options.responseOverrides
    }

    if (options.baseline !== null) {
      const encoded = yield* Schema.encodeEffect(AuditBaselineJson)([...(options.baseline ?? [])])
      yield* fs.writeFileString(path.join(root, "effect-audit-baseline.json"), `${encoded}\n`)
    }

    return { root, responses, indexedFiles }
  }
)

const languageDiagnostic = (
  root: string,
  severity: "error" | "message" = "error"
): Schema.Schema.Type<typeof LanguageDiagnostic> => ({
  file: `${root}/src/main.ts`,
  start: 7,
  length: 5,
  line: 1,
  column: 8,
  endLine: 1,
  endColumn: 13,
  severity,
  code: 1,
  name: "asyncFunction",
  message: "Use Effect instead"
})

const eslintMessage = (): Schema.Schema.Type<typeof EslintMessage> => ({
  ruleId: "local/effect-boundary",
  severity: 2,
  message: "Use Effect composition instead of a native async function.",
  messageId: "nativeAsync",
  line: 1,
  column: 8,
  endLine: 1,
  endColumn: 43
})

const expectedRequests = (root: string): ReadonlyArray<AuditCommandRequest> => [{
  name: "language-service",
  command: "effect-language-service",
  args: ["diagnostics", "--project", "tsconfig.effect-audit.json", "--format", "json", "--severity", "error,message"],
  cwd: root,
  acceptedExitCodes: [0, 1]
}, {
  name: "eslint",
  command: "eslint",
  args: ["--config", "eslint.effect.config.mjs", ".", "--format", "json"],
  cwd: root,
  acceptedExitCodes: [0, 1]
}, {
  name: "typescript-files",
  command: "tsc",
  args: ["--listFilesOnly", "-p", "tsconfig.effect-audit.json"],
  cwd: root,
  acceptedExitCodes: [0]
}, {
  name: "tracked-files",
  command: "git",
  args: ["ls-files", "-z"],
  cwd: root,
  acceptedExitCodes: [0]
}, {
  name: "tracked-modes",
  command: "git",
  args: ["ls-files", "-s", "-z"],
  cwd: root,
  acceptedExitCodes: [0]
}]

describe("Effect audit model", () => {
  it("implements exact policy schemas", () => {
    expect(Exit.isSuccess(Schema.decodeUnknownExit(NonNegativeInt)(0))).toBe(true)
    expect(Exit.isFailure(Schema.decodeUnknownExit(NonNegativeInt)(-1))).toBe(true)
    expect(Exit.isSuccess(Schema.decodeUnknownExit(PositiveInt)(1))).toBe(true)
    expect(Exit.isFailure(Schema.decodeUnknownExit(PositiveInt)(0))).toBe(true)
    expect(new SourceIdentity({
      file: "src/a.ts",
      declaration: "function:a",
      construct: "native:await",
      occurrence: 0
    })).toEqual({
      file: "src/a.ts",
      declaration: "function:a",
      construct: "native:await",
      occurrence: 0
    })
    expect(new HostBoundary({
      file: "src/a.ts",
      declaration: "function:a",
      host: "Host callback",
      construct: "native:async",
      occurrence: 0
    }).host).toBe("Host callback")
  })

  it("keeps display data out of stable identity", () => {
    const moved = makeFinding({ line: 40, excerpt: "new display" })
    const original = makeFinding({ line: 2, excerpt: "old display" })
    expect(findingKey(moved)).toBe(findingKey(original))
  })

  it("disambiguates occurrences and engines", () => {
    const first = makeFinding()
    expect(findingKey(makeFinding({ occurrence: 1 }))).not.toBe(findingKey(first))
    expect(findingKey(makeFinding({ engine: "effect-language-service" }))).not.toBe(findingKey(first))
  })

  it("deduplicates same-engine semantic records and sorts comparisons by key", () => {
    const z = makeFinding({ file: "z.ts" })
    const a = makeFinding({ file: "a.ts" })
    const comparison = compareAudit([], [z, a, makeFinding({ file: "a.ts", line: 90 })])
    expect(comparison.added.map(findingKey)).toEqual([findingKey(a), findingKey(z)])
  })

  it("keeps advisory messages out of the blocking ledger", () => {
    const message = makeFinding({ severity: "message" })
    expect(compareAudit([], [message])).toEqual({ added: [], removed: [] })
    expect(canUpdateBaseline([], [message])).toBe(true)
  })

  it("allows identical and strict-subset updates but rejects additions", () => {
    const first = makeFinding({ file: "a.ts" })
    const second = makeFinding({ file: "b.ts" })
    expect(canUpdateBaseline([first, second], [first, second])).toBe(true)
    expect(canUpdateBaseline([first, second], [first])).toBe(true)
    expect(canUpdateBaseline([first], [first, second])).toBe(false)
    expect(compareAudit([first, second], [first])).toEqual({ added: [], removed: [second] })
  })
})

describe("runAudit", () => {
  it.effect("runs every exact command and normalizes language-service findings", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture({
        baseline: [asyncLanguageFinding],
        languageDiagnostics: (root) => [languageDiagnostic(root)]
      })
      const requests: Array<AuditCommandRequest> = []
      const result = yield* runAudit({ root: fixture.root, mode: "check" }).pipe(
        Effect.provide(makeRunnerLayer(fixture.responses, requests))
      )
      expect(requests).toEqual(expectedRequests(fixture.root))
      expect(result.blocking.map(findingKey)).toEqual([findingKey(asyncLanguageFinding)])
      expect(result.blocking[0]?.line).toBe(1)
      expect(result.blocking[0]?.excerpt).toContain("export async function load")
      expect(result.advisory).toEqual([])
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("normalizes ESLint findings through the same source identity", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture({
        baseline: [asyncEslintFinding],
        eslintMessages: [eslintMessage()]
      })
      const result = yield* runAudit({ root: fixture.root, mode: "check" }).pipe(
        Effect.provide(makeRunnerLayer(fixture.responses, []))
      )
      expect(result.blocking.map(findingKey)).toEqual([findingKey(asyncEslintFinding)])
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("reports advisory language-service messages without ledgering them", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture({
        baseline: [],
        languageDiagnostics: (root) => [languageDiagnostic(root, "message")]
      })
      const result = yield* runAudit({ root: fixture.root, mode: "check" }).pipe(
        Effect.provide(makeRunnerLayer(fixture.responses, []))
      )
      expect(result.blocking).toEqual([])
      expect(result.advisory).toHaveLength(1)
      expect(result.advisory[0]?.severity).toBe("message")
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects a missing baseline in check and update modes", () =>
    Effect.gen(function*() {
      for (const mode of ["check", "update"] as const) {
        const fixture = yield* makeFixture({ baseline: null })
        const error = yield* runAudit({ root: fixture.root, mode }).pipe(
          Effect.provide(makeRunnerLayer(fixture.responses, [])),
          Effect.flip
        )
        expect(error.reason).toBe("baseline-missing")
      }
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects message, duplicate, and unsorted committed baseline entries", () =>
    Effect.gen(function*() {
      const invalidBaselines = [
        [makeFinding({ severity: "message" })],
        [makeFinding(), makeFinding({ line: 50 })],
        [makeFinding({ file: "z.ts" }), makeFinding({ file: "a.ts" })]
      ]
      for (const baseline of invalidBaselines) {
        const fixture = yield* makeFixture({ baseline })
        const error = yield* runAudit({ root: fixture.root, mode: "check" }).pipe(
          Effect.provide(makeRunnerLayer(fixture.responses, [])),
          Effect.flip
        )
        expect(error.reason).toBe("invalid-output")
      }
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects new findings in check and growth in update", () =>
    Effect.gen(function*() {
      for (const mode of ["check", "update"] as const) {
        const fixture = yield* makeFixture({
          baseline: [],
          languageDiagnostics: (root) => [languageDiagnostic(root)]
        })
        const error = yield* runAudit({ root: fixture.root, mode }).pipe(
          Effect.provide(makeRunnerLayer(fixture.responses, [])),
          Effect.flip
        )
        expect(error.reason).toBe(mode === "check" ? "new-findings" : "baseline-growth")
      }
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("keeps removed entries stale until a shrink-only update", () =>
    Effect.gen(function*() {
      const stale = makeFinding({ file: "removed.ts" })
      const fixture = yield* makeFixture({ baseline: [stale] })
      const layer = makeRunnerLayer(fixture.responses, [])
      const before = yield* runAudit({ root: fixture.root, mode: "check" }).pipe(
        Effect.provide(layer),
        Effect.flip
      )
      expect(before.reason).toBe("stale-baseline")
      yield* runAudit({ root: fixture.root, mode: "update" }).pipe(Effect.provide(layer))
      const fs = yield* FileSystem.FileSystem
      const encoded = yield* fs.readFileString(`${fixture.root}/effect-audit-baseline.json`)
      expect(yield* Schema.decodeUnknownEffect(AuditBaselineJson)(encoded)).toEqual([])
      const after = yield* runAudit({ root: fixture.root, mode: "check" }).pipe(Effect.provide(layer))
      expect(after.blocking).toEqual([])
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("turns malformed and empty JSON into typed invalid-output errors", () =>
    Effect.gen(function*() {
      for (const name of ["language-service", "eslint"] as const) {
        for (const stdout of ["", "not-json"]) {
          const fixture = yield* makeFixture({ baseline: [] })
          const responses = {
            ...fixture.responses,
            [name]: { exitCode: 1, stdout, stderr: "diagnostic output" }
          }
          const error = yield* runAudit({ root: fixture.root, mode: "check" }).pipe(
            Effect.provide(makeRunnerLayer(responses, [])),
            Effect.flip
          )
          expect(error.reason).toBe("invalid-output")
          expect(error.detail).toContain(name)
        }
      }
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects malformed ESLint severities as invalid output", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture({ baseline: [], eslintMessages: [eslintMessage()] })
      const stdout = fixture.responses.eslint.stdout.replace('"severity":2', '"severity":3')
      expect(stdout).not.toBe(fixture.responses.eslint.stdout)
      const responses = {
        ...fixture.responses,
        eslint: { ...fixture.responses.eslint, stdout }
      }
      const error = yield* runAudit({ root: fixture.root, mode: "check" }).pipe(
        Effect.provide(makeRunnerLayer(responses, [])),
        Effect.flip
      )
      expect(error.reason).toBe("invalid-output")
      expect(error.detail).toContain("eslint")
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects an empty TypeScript file list as invalid output", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture({ baseline: [] })
      const responses = {
        ...fixture.responses,
        "typescript-files": { exitCode: 0, stdout: "", stderr: "" }
      }
      const error = yield* runAudit({ root: fixture.root, mode: "check" }).pipe(
        Effect.provide(makeRunnerLayer(responses, [])),
        Effect.flip
      )
      expect(error.reason).toBe("invalid-output")
      expect(error.detail).toContain("typescript-files")
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("turns unaccepted exit codes into typed command failures", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture({ baseline: [] })
      const responses = {
        ...fixture.responses,
        "typescript-files": { exitCode: 2, stdout: "", stderr: "typecheck failed" }
      }
      const error = yield* runAudit({ root: fixture.root, mode: "check" }).pipe(
        Effect.provide(makeRunnerLayer(responses, [])),
        Effect.flip
      )
      expect(error.reason).toBe("command-failed")
      expect(error.detail).toContain("typescript-files")
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("preserves typed runner platform failures", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture({ baseline: [] })
      const expected = new EffectAuditError({
        reason: "command-failed",
        findings: [],
        detail: "signal termination"
      })
      const error = yield* runAudit({ root: fixture.root, mode: "check" }).pipe(
        Effect.provide(makeRunnerLayer(fixture.responses, [], { name: "language-service", error: expected })),
        Effect.flip
      )
      expect(error).toBe(expected)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("fails when TypeScript or ESLint omits an indexed source", () =>
    Effect.gen(function*() {
      for (const omission of ["omitTypeScriptFile", "omitEslintFile"] as const) {
        const fixture = yield* makeFixture({ baseline: [], [omission]: "src/main.ts" })
        const error = yield* runAudit({ root: fixture.root, mode: "check" }).pipe(
          Effect.provide(makeRunnerLayer(fixture.responses, [])),
          Effect.flip
        )
        expect(error.reason).toBe("coverage-gap")
        expect(error.detail).toContain("src/main.ts")
      }
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("fails when ESLint omits an indexed clean JavaScript source", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture({ baseline: [], omitEslintFile: cleanJavaScriptFile })
      const error = yield* runAudit({ root: fixture.root, mode: "check" }).pipe(
        Effect.provide(makeRunnerLayer(fixture.responses, [])),
        Effect.flip
      )
      expect(error.reason).toBe("coverage-gap")
      expect(error.detail).toContain(cleanJavaScriptFile)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("ignores unindexed ESLint fatals and findings before parsing", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture({
        baseline: [],
        extraEslintResults: (root) => [{
          filePath: `${root}/unindexed/missing.ts`,
          messages: [{
            ruleId: null,
            severity: 2,
            message: "Parsing failed",
            fatal: true,
            line: 1,
            column: 1
          }, {
            ruleId: "local/effect-boundary",
            severity: 2,
            message: "Use Effect composition instead of a native async function.",
            messageId: "nativeAsync",
            line: 1,
            column: 1,
            endLine: 1,
            endColumn: 6
          }]
        }]
      })
      const result = yield* runAudit({ root: fixture.root, mode: "check" }).pipe(
        Effect.provide(makeRunnerLayer(fixture.responses, []))
      )
      expect(result.blocking).toEqual([])
      expect(result.advisory).toEqual([])
    }).pipe(Effect.provide(NodeServices.layer)))
})

describe("AuditCommandRunnerLive", () => {
  it.effect("drains stdout, stderr, and exit status concurrently", () =>
    Effect.gen(function*() {
      const runner = yield* AuditCommandRunner
      const result = yield* runner.run({
        name: "typescript-files",
        command: "node",
        args: [
          "-e",
          "const fs=require('node:fs');const chunk='x'.repeat(65536);for(let i=0;i<32;i++){fs.writeSync(1,chunk);fs.writeSync(2,chunk)}fs.writeSync(1,'done-out');fs.writeSync(2,'done-err')"
        ],
        cwd: ".",
        acceptedExitCodes: [0]
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.length).toBe(2_097_160)
      expect(result.stderr.length).toBe(2_097_160)
      expect(result.stdout.endsWith("done-out")).toBe(true)
      expect(result.stderr.endsWith("done-err")).toBe(true)
    }).pipe(
      Effect.provide(AuditCommandRunnerLive),
      Effect.provide(NodeServices.layer)
    ))

  it.effect("maps signal termination to EffectAuditError", () =>
    Effect.gen(function*() {
      const runner = yield* AuditCommandRunner
      const error = yield* runner.run({
        name: "typescript-files",
        command: "node",
        args: ["-e", "process.kill(process.pid, 'SIGTERM')"],
        cwd: ".",
        acceptedExitCodes: [0]
      }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(EffectAuditError)
      expect(error.reason).toBe("command-failed")
    }).pipe(
      Effect.provide(AuditCommandRunnerLive),
      Effect.provide(NodeServices.layer)
    ))
})

describe("Effect audit CLI", () => {
  it.effect("uses the guarded installed-beta command shape and exact package scripts", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* path.fromFileUrl(new URL("../", import.meta.url))
      const packageJson = yield* Schema.decodeUnknownEffect(PackageJson)(
        yield* fs.readFileString(path.join(root, "package.json"))
      )
      const source = yield* fs.readFileString(path.join(root, "scripts/effect-audit.ts"))
      expect(packageJson.scripts["effect:audit"]).toBe("tsx scripts/effect-audit.ts")
      expect(packageJson.scripts["effect:audit:update"]).toBe("tsx scripts/effect-audit.ts --update")
      expect(source).toContain("Command.make(\"effect-audit\", { update: Flag.boolean(\"update\") }")
      expect(source).toContain("Command.run(command, { version: \"0.0.0\" })")
      expect(source).toContain("path.fromFileUrl(new URL(\"../\", import.meta.url))")
      expect(source).toContain("if (import.meta.main)")
      expect(source).toContain("NodeRuntime.runMain")
      expect(source).not.toContain("process.argv")
      expect(source).not.toContain("initialize")
    }).pipe(Effect.provide(NodeServices.layer)))
})
