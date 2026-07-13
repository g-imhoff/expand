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
  runAudit,
  utf8ByteOffsetToCodeUnit
} from "./effect-audit"
import {
  AuditBaselineJson,
  AuditFinding,
  EffectAuditError,
  canUpdateBaseline,
  compareAudit,
  findingKey
} from "./effect-audit-model"
import {
  GrepCandidate,
  GrepInventoryJson,
  compareGrepInventory,
  grepCandidateCounts,
  grepCandidateKey,
  prepareGrepInventoryUpdate,
  validateGrepInventory
} from "./effect-inventory-model"
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

const makeCandidate = (overrides: Partial<GrepCandidate> = {}) => new GrepCandidate({
  file: "src/main.ts",
  declaration: "function:load",
  construct: "native:async",
  occurrence: 0,
  classification: "migration-debt",
  rationale: "",
  line: 1,
  excerpt: "export async function load() { return 1 }",
  ...overrides
})

const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const grepSummaryEvent = () => ({
  type: "summary",
  data: {
    elapsed_total: { human: "0.000001s", nanos: 1, secs: 0 },
    stats: {
      bytes_printed: 0,
      bytes_searched: 0,
      elapsed: { human: "0.000001s", nanos: 1, secs: 0 },
      matched_lines: 0,
      matches: 0,
      searches: 1,
      searches_with_match: 0
    }
  }
})

const grepSummary = () => `${encodeUnknownJson(grepSummaryEvent())}\n`

interface GrepSubmatch {
  readonly text: string
  readonly start: number
  readonly end: number
}

const grepOutput = (input: {
  readonly file?: string
  readonly line?: number | null
  readonly absoluteOffset?: number
  readonly text: string
  readonly submatches: ReadonlyArray<GrepSubmatch>
}) => [{
  type: "begin",
  data: { path: { text: input.file ?? "./src/main.ts" } }
}, {
  type: "match",
  data: {
    path: { text: input.file ?? "./src/main.ts" },
    lines: { text: input.text },
    line_number: input.line === undefined ? 1 : input.line,
    absolute_offset: input.absoluteOffset ?? 0,
    submatches: input.submatches.map((submatch) => ({
      match: { text: submatch.text },
      start: submatch.start,
      end: submatch.end
    }))
  }
}, {
  type: "end",
  data: { path: { text: input.file ?? "./src/main.ts" }, binary_offset: null, stats: {} }
}, grepSummaryEvent()].map((event) => encodeUnknownJson(event)).join("\n") + "\n"

const expectedGrepPattern = "\\basync\\b|\\bawait\\b|new\\s+Promise\\b|\\bPromise(?:Like)?\\s*<|\\bPromise\\.(?:all|allSettled|any|race|resolve|reject)\\b|\\.(?:then|catch|finally)\\s*\\(|\\b(?:setTimeout|setInterval|setImmediate|queueMicrotask|fetch)\\s*\\(|new\\s+(?:Date|WebSocket|Worker|MessageChannel|BroadcastChannel)\\s*\\(|\\b(?:console\\.\\w+|Date\\.now|performance\\.now|Math\\.random|crypto\\.randomUUID|JSON\\.(?:parse|stringify)|process\\.[A-Za-z_$][A-Za-z0-9_$]*|(?:window|document|navigator|localStorage|sessionStorage)\\.)|\\bnode:[^'\"[:space:]]+|\\b[A-Za-z_$][A-Za-z0-9_$]*\\.run(?:Promise(?:Exit)?|Sync(?:Exit)?|Fork|Callback|Main)\\b"

const utf8Length = (text: string) => {
  let bytes = 0
  for (let index = 0; index < text.length;) {
    const point = text.codePointAt(index) ?? 0
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
    index += point > 0xffff ? 2 : 1
  }
  return bytes
}

const commandOrder: ReadonlyArray<AuditCommandRequest["name"]> = [
  "language-service",
  "eslint",
  "typescript-files",
  "tracked-files",
  "tracked-modes",
  "grep-json"
]

type CommandResponses = Record<AuditCommandRequest["name"], AuditCommandResult>

interface FixtureOptions {
  readonly baseline?: ReadonlyArray<AuditFinding> | null
  readonly grepInventory?: ReadonlyArray<GrepCandidate> | null
  readonly mainSource?: string
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
    const workspaceRoot = yield* path.fromFileUrl(new URL("../", import.meta.url))
    const fixtureDirectory = path.join(workspaceRoot, ".superpowers", "effect-audit-fixtures")
    yield* fs.makeDirectory(fixtureDirectory, { recursive: true })
    const root = yield* fs.makeTempDirectoryScoped({ directory: fixtureDirectory, prefix: "effect-audit-" })
    const indexedFiles = Array.from(new Set([
      mainFile,
      cleanJavaScriptFile,
      ...effectHostBoundaries.map((boundary) => boundary.file)
    ])).sort()

    yield* fs.makeDirectory(path.join(root, "src"), { recursive: true })
    yield* fs.writeFileString(
      path.join(root, mainFile),
      options.mainSource ?? "export async function load() { return 1 }\n"
    )
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
      "grep-json": { exitCode: 1, stdout: grepSummary(), stderr: "" },
      ...options.responseOverrides
    }

    if (options.baseline !== null) {
      const encoded = yield* Schema.encodeEffect(AuditBaselineJson)([...(options.baseline ?? [])])
      yield* fs.writeFileString(path.join(root, "effect-audit-baseline.json"), `${encoded}\n`)
    }

    if (options.grepInventory !== null) {
      const encoded = yield* Schema.encodeEffect(GrepInventoryJson)([...(options.grepInventory ?? [])])
      yield* fs.writeFileString(path.join(root, "effect-grep-inventory.json"), `${encoded}\n`)
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
}, {
  name: "grep-json",
  command: "rg",
  args: [
    "-n",
    "--json",
    "--hidden",
    "-g",
    "*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
    "-g",
    "!.git/**",
    "-g",
    "!**/node_modules/**",
    "-g",
    "!**/{dist,out,build,coverage,test-results,playwright-report}/**",
    expectedGrepPattern,
    "."
  ],
  cwd: root,
  acceptedExitCodes: [0, 1]
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

describe("grep inventory model", () => {
  it("decodes the exact candidate schema and keeps display/classification data out of identity", () => {
    const candidate = makeCandidate()
    const encoded = Schema.encodeSync(GrepInventoryJson)([candidate])
    expect(Schema.decodeSync(GrepInventoryJson)(encoded)).toEqual([candidate])
    expect(grepCandidateKey(makeCandidate({
      classification: "false-positive",
      rationale: "Analyzer proves Effect.catch is not native Promise chaining",
      line: 30,
      excerpt: "moved"
    }))).toBe(grepCandidateKey(candidate))
    expect(Exit.isFailure(Schema.decodeUnknownExit(GrepInventoryJson)("[]"))).toBe(false)
    expect(Exit.isFailure(Schema.decodeUnknownExit(GrepInventoryJson)("[{\"occurrence\":-1}]"))).toBe(true)
  })

  it("sorts comparisons by exact identity and rejects duplicate or unsorted inventories", () => {
    const a = makeCandidate({ file: "a.ts" })
    const z = makeCandidate({ file: "z.ts" })
    expect(validateGrepInventory([a, z])).toBeUndefined()
    expect(validateGrepInventory([z, a])).toContain("sorted")
    expect(validateGrepInventory([a, makeCandidate({ file: "a.ts", line: 20 })])).toContain("duplicate")
    expect(compareGrepInventory([], [z, a]).added.map(grepCandidateKey)).toEqual([
      grepCandidateKey(a),
      grepCandidateKey(z)
    ])
  })

  it("preserves one record per declaration, construct, and occurrence", () => {
    const first = makeCandidate()
    const second = makeCandidate({ occurrence: 1 })
    const moved = makeCandidate({ declaration: "function:moved" })
    expect(new Set([first, second, moved].map(grepCandidateKey)).size).toBe(3)
  })

  it("prepares only strict-subset debt updates while preserving reviewed metadata", () => {
    const debt = makeCandidate({ file: "a.ts" })
    const reviewed = makeCandidate({
      file: "b.ts",
      classification: "false-positive",
      rationale: "Analyzer proves the receiver is Effect",
      line: 1,
      excerpt: "old"
    })
    const current = makeCandidate({ file: "b.ts", line: 50, excerpt: "new" })
    expect(prepareGrepInventoryUpdate([debt, reviewed], [current])).toEqual({
      inventory: [makeCandidate({
        file: "b.ts",
        classification: "false-positive",
        rationale: "Analyzer proves the receiver is Effect",
        line: 50,
        excerpt: "new"
      })],
      added: [],
      protectedRemoved: []
    })
    expect(prepareGrepInventoryUpdate([reviewed], []).protectedRemoved).toEqual([reviewed])
    expect(prepareGrepInventoryUpdate([], [debt]).added).toEqual([debt])
  })

  it("counts every classification without inferring promotions", () => {
    expect(grepCandidateCounts([
      makeCandidate(),
      makeCandidate({ occurrence: 1, classification: "host-boundary", rationale: "Permanent registry" }),
      makeCandidate({ occurrence: 2, classification: "host-required-type", rationale: "Host signature" }),
      makeCandidate({ occurrence: 3, classification: "audit-fixture", rationale: "Rule fixture" }),
      makeCandidate({ occurrence: 4, classification: "false-positive", rationale: "Effect API" })
    ])).toEqual({
      "migration-debt": 1,
      "host-boundary": 1,
      "host-required-type": 1,
      "audit-fixture": 1,
      "false-positive": 1
    })
  })
})

describe("UTF-8 byte offsets", () => {
  it("converts ASCII, BMP, astral, and end boundaries to UTF-16 code units", () => {
    expect(utf8ByteOffsetToCodeUnit("await", 0)).toBe(0)
    expect(utf8ByteOffsetToCodeUnit("await", 5)).toBe(5)
    expect(utf8ByteOffsetToCodeUnit("—await", 3)).toBe(1)
    expect(utf8ByteOffsetToCodeUnit("x😀 await", 1)).toBe(1)
    expect(utf8ByteOffsetToCodeUnit("x😀 await", 5)).toBe(3)
    expect(utf8ByteOffsetToCodeUnit("x😀 await", 6)).toBe(4)
    expect(utf8ByteOffsetToCodeUnit("x😀 await", 11)).toBe(9)
  })

  it("rejects negative, fractional, unsafe, past-end, and inside-code-point offsets", () => {
    for (const offset of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, 2, 3, 4, 12]) {
      expect(utf8ByteOffsetToCodeUnit("x😀 await", offset)).toBeUndefined()
    }
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

  it.effect("accepts exit 1 only with a well-formed summary-only grep stream", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture({ baseline: [], grepInventory: [] })
      const result = yield* runAudit({ root: fixture.root, mode: "check" }).pipe(
        Effect.provide(makeRunnerLayer(fixture.responses, []))
      )
      expect(result.candidateCounts).toEqual({
        "migration-debt": 0,
        "host-boundary": 0,
        "host-required-type": 0,
        "audit-fixture": 0,
        "false-positive": 0
      })

      for (const stdout of ["", "not-json\n"]) {
        const error = yield* runAudit({ root: fixture.root, mode: "check" }).pipe(
          Effect.provide(makeRunnerLayer({
            ...fixture.responses,
            "grep-json": { exitCode: 1, stdout, stderr: "" }
          }, [])),
          Effect.flip
        )
        expect(error.reason).toBe("invalid-output")
        expect(error.detail).toContain("grep-json")
      }
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects missing grep inventory in check and update modes", () =>
    Effect.gen(function*() {
      for (const mode of ["check", "update"] as const) {
        const fixture = yield* makeFixture({ baseline: [], grepInventory: null })
        const error = yield* runAudit({ root: fixture.root, mode }).pipe(
          Effect.provide(makeRunnerLayer(fixture.responses, [])),
          Effect.flip
        )
        expect(error.reason).toBe("baseline-missing")
        expect(error.detail).toContain("effect-grep-inventory.json")
      }
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects new or moved grep candidates and stale inventory in check mode", () =>
    Effect.gen(function*() {
      const output = grepOutput({
        text: "export async function load() { return 1 }\n",
        submatches: [{ text: "async", start: 7, end: 12 }]
      })
      for (const inventory of [
        [],
        [makeCandidate({ declaration: "function:moved" })]
      ]) {
        const fixture = yield* makeFixture({
          baseline: [],
          grepInventory: inventory,
          responseOverrides: { "grep-json": { exitCode: 0, stdout: output, stderr: "" } }
        })
        const error = yield* runAudit({ root: fixture.root, mode: "check" }).pipe(
          Effect.provide(makeRunnerLayer(fixture.responses, [])),
          Effect.flip
        )
        expect(error.reason).toBe("new-findings")
      }

      const staleFixture = yield* makeFixture({ baseline: [], grepInventory: [makeCandidate()] })
      const stale = yield* runAudit({ root: staleFixture.root, mode: "check" }).pipe(
        Effect.provide(makeRunnerLayer(staleFixture.responses, [])),
        Effect.flip
      )
      expect(stale.reason).toBe("stale-baseline")
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("updates only a strict subset of migration debt and is byte-idempotent", () =>
    Effect.gen(function*() {
      const survivor = makeCandidate()
      const stale = makeCandidate({ file: "src/removed.ts" })
      const output = grepOutput({
        text: "export async function load() { return 1 }\n",
        submatches: [{ text: "async", start: 7, end: 12 }]
      })
      const fixture = yield* makeFixture({
        baseline: [],
        grepInventory: [stale, survivor].sort((left, right) => grepCandidateKey(left).localeCompare(grepCandidateKey(right))),
        responseOverrides: { "grep-json": { exitCode: 0, stdout: output, stderr: "" } }
      })
      const layer = makeRunnerLayer(fixture.responses, [])
      yield* runAudit({ root: fixture.root, mode: "update" }).pipe(Effect.provide(layer))
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const inventoryPath = path.join(fixture.root, "effect-grep-inventory.json")
      const first = yield* fs.readFileString(inventoryPath)
      expect(yield* Schema.decodeUnknownEffect(GrepInventoryJson)(first)).toEqual([survivor])
      yield* runAudit({ root: fixture.root, mode: "update" }).pipe(Effect.provide(layer))
      expect(yield* fs.readFileString(inventoryPath)).toBe(first)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("never creates or grows the grep inventory during update", () =>
    Effect.gen(function*() {
      const output = grepOutput({
        text: "export async function load() { return 1 }\n",
        submatches: [{ text: "async", start: 7, end: 12 }]
      })
      const fixture = yield* makeFixture({
        baseline: [],
        grepInventory: [],
        responseOverrides: { "grep-json": { exitCode: 0, stdout: output, stderr: "" } }
      })
      const error = yield* runAudit({ root: fixture.root, mode: "update" }).pipe(
        Effect.provide(makeRunnerLayer(fixture.responses, [])),
        Effect.flip
      )
      expect(error.reason).toBe("baseline-growth")
      const fs = yield* FileSystem.FileSystem
      expect(yield* fs.readFileString(`${fixture.root}/effect-grep-inventory.json`)).toBe("[]\n")
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("preserves reviewed classification and rationale while refreshing display fields", () =>
    Effect.gen(function*() {
      const source = [
        "import { Effect } from \"effect\"",
        "export const recover = Effect.catch(value)",
        ""
      ].join("\n")
      const line = "export const recover = Effect.catch(value)\n"
      const start = line.indexOf(".catch(")
      const current = makeCandidate({
        declaration: "variable:recover",
        construct: "lexical:.catch(",
        classification: "false-positive",
        rationale: "Analyzer proves the receiver is the Effect module",
        line: 2,
        excerpt: "old"
      })
      const fixture = yield* makeFixture({
        baseline: [],
        grepInventory: [current],
        mainSource: source,
        responseOverrides: {
          "grep-json": {
            exitCode: 0,
            stdout: grepOutput({
              line: 2,
              absoluteOffset: source.indexOf(line),
              text: line,
              submatches: [{ text: ".catch(", start, end: start + 7 }]
            }),
            stderr: ""
          }
        }
      })
      yield* runAudit({ root: fixture.root, mode: "update" }).pipe(
        Effect.provide(makeRunnerLayer(fixture.responses, []))
      )
      const fs = yield* FileSystem.FileSystem
      const inventory = yield* Schema.decodeUnknownEffect(GrepInventoryJson)(
        yield* fs.readFileString(`${fixture.root}/effect-grep-inventory.json`)
      )
      expect(inventory).toEqual([makeCandidate({
        declaration: "variable:recover",
        construct: "lexical:.catch(",
        classification: "false-positive",
        rationale: "Analyzer proves the receiver is the Effect module",
        line: 2,
        excerpt: line.trimEnd()
      })])
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("refuses to remove or rewrite a reviewed non-debt record", () =>
    Effect.gen(function*() {
      const reviewed = makeCandidate({
        classification: "false-positive",
        rationale: "Reviewed evidence"
      })
      const fixture = yield* makeFixture({ baseline: [], grepInventory: [reviewed] })
      const fs = yield* FileSystem.FileSystem
      const before = yield* fs.readFileString(`${fixture.root}/effect-grep-inventory.json`)
      const error = yield* runAudit({ root: fixture.root, mode: "update" }).pipe(
        Effect.provide(makeRunnerLayer(fixture.responses, [])),
        Effect.flip
      )
      expect(error.reason).toBe("stale-baseline")
      expect(yield* fs.readFileString(`${fixture.root}/effect-grep-inventory.json`)).toBe(before)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("maps multiple submatches with independent lexical occurrence indexes after emoji", () =>
    Effect.gen(function*() {
      const source = [
        "import { Effect } from \"effect\"",
        "export const recover = () => [Effect.catch(value), \"😀\", Effect.catch(other)]",
        ""
      ].join("\n")
      const line = source.split("\n")[1] + "\n"
      const firstCodeUnit = line.indexOf(".catch(")
      const secondCodeUnit = line.indexOf(".catch(", firstCodeUnit + 1)
      const first = utf8Length(line.slice(0, firstCodeUnit))
      const second = utf8Length(line.slice(0, secondCodeUnit))
      const candidates = [0, 1].map((occurrence) => makeCandidate({
        declaration: "variable:recover",
        construct: "lexical:.catch(",
        occurrence,
        line: 2,
        excerpt: line.trimEnd()
      }))
      const fixture = yield* makeFixture({
        baseline: [],
        grepInventory: candidates,
        mainSource: source,
        responseOverrides: {
          "grep-json": {
            exitCode: 0,
            stdout: grepOutput({
              line: 2,
              absoluteOffset: utf8Length(source.slice(0, source.indexOf(line))),
              text: line,
              submatches: [
                { text: ".catch(", start: first, end: first + 7 },
                { text: ".catch(", start: second, end: second + 7 }
              ]
            }),
            stderr: ""
          }
        }
      })
      const result = yield* runAudit({ root: fixture.root, mode: "check" }).pipe(
        Effect.provide(makeRunnerLayer(fixture.responses, []))
      )
      expect(result.candidateCounts["migration-debt"]).toBe(2)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("keeps unrelated matches lexical inside a wide exported Effect function", () =>
    Effect.gen(function*() {
      const source = [
        "import { Effect } from \"effect\"",
        "export const renderErrors = <A>(program: Effect.Effect<A>): Effect.Effect<A> => program.pipe(Effect.catch(() => [JSON.stringify(a), JSON.stringify(b)]))",
        ""
      ].join("\n")
      const line = source.split("\n")[1] + "\n"
      const catchStart = line.indexOf(".catch(")
      const firstJson = line.indexOf("JSON.stringify")
      const secondJson = line.indexOf("JSON.stringify", firstJson + 1)
      const inventory = [
        makeCandidate({
          declaration: "variable:renderErrors",
          construct: "lexical:.catch(",
          line: 2,
          excerpt: line.trimEnd()
        }),
        makeCandidate({
          declaration: "variable:renderErrors",
          construct: "lexical:JSON.stringify",
          line: 2,
          excerpt: line.trimEnd()
        }),
        makeCandidate({
          declaration: "variable:renderErrors",
          construct: "lexical:JSON.stringify",
          occurrence: 1,
          line: 2,
          excerpt: line.trimEnd()
        })
      ].sort((left, right) => grepCandidateKey(left).localeCompare(grepCandidateKey(right)))
      const fixture = yield* makeFixture({
        baseline: [],
        grepInventory: inventory,
        mainSource: source,
        responseOverrides: {
          "grep-json": {
            exitCode: 0,
            stdout: grepOutput({
              line: 2,
              absoluteOffset: source.indexOf(line),
              text: line,
              submatches: [
                { text: ".catch(", start: catchStart, end: catchStart + 7 },
                { text: "JSON.stringify", start: firstJson, end: firstJson + 14 },
                { text: "JSON.stringify", start: secondJson, end: secondJson + 14 }
              ]
            }),
            stderr: ""
          }
        }
      })
      const result = yield* runAudit({ root: fixture.root, mode: "check" }).pipe(
        Effect.provide(makeRunnerLayer(fixture.responses, []))
      )
      expect(result.candidateCounts["migration-debt"]).toBe(3)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("selects only compatible matches inside an outer platform construct", () =>
    Effect.gen(function*() {
      const source = "export const schedule = () => setTimeout(() => [JSON.stringify(a), JSON.stringify(b)], 0)\n"
      const timeoutStart = source.indexOf("setTimeout(")
      const firstJson = source.indexOf("JSON.stringify")
      const secondJson = source.indexOf("JSON.stringify", firstJson + 1)
      const inventory = [
        makeCandidate({
          declaration: "variable:schedule",
          construct: "platform:setTimeout",
          line: 1,
          excerpt: source.trimEnd()
        }),
        makeCandidate({
          declaration: "variable:schedule",
          construct: "lexical:JSON.stringify",
          line: 1,
          excerpt: source.trimEnd()
        }),
        makeCandidate({
          declaration: "variable:schedule",
          construct: "lexical:JSON.stringify",
          occurrence: 1,
          line: 1,
          excerpt: source.trimEnd()
        })
      ].sort((left, right) => grepCandidateKey(left).localeCompare(grepCandidateKey(right)))
      const fixture = yield* makeFixture({
        baseline: [],
        grepInventory: inventory,
        mainSource: source,
        responseOverrides: {
          "grep-json": {
            exitCode: 0,
            stdout: grepOutput({
              text: source,
              submatches: [
                { text: "setTimeout(", start: timeoutStart, end: timeoutStart + 11 },
                { text: "JSON.stringify", start: firstJson, end: firstJson + 14 },
                { text: "JSON.stringify", start: secondJson, end: secondJson + 14 }
              ]
            }),
            stderr: ""
          }
        }
      })
      const result = yield* runAudit({ root: fixture.root, mode: "check" }).pipe(
        Effect.provide(makeRunnerLayer(fixture.responses, []))
      )
      expect(result.candidateCounts["migration-debt"]).toBe(3)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("falls back to the nearest nested declaration after rejecting an outer occurrence", () =>
    Effect.gen(function*() {
      const source = [
        "export const schedule = () => setTimeout(function nested() {",
        "  return JSON.stringify(value)",
        "}, 0)",
        ""
      ].join("\n")
      const line = "  return JSON.stringify(value)\n"
      const start = line.indexOf("JSON.stringify")
      const fixture = yield* makeFixture({
        baseline: [],
        grepInventory: [makeCandidate({
          declaration: "variable:schedule/scope:anonymous:VariableDeclarator:init:variable:schedule:0/function:nested",
          construct: "lexical:JSON.stringify",
          line: 2,
          excerpt: line.trimEnd()
        })],
        mainSource: source,
        responseOverrides: {
          "grep-json": {
            exitCode: 0,
            stdout: grepOutput({
              line: 2,
              absoluteOffset: source.indexOf(line),
              text: line,
              submatches: [{ text: "JSON.stringify", start, end: start + 14 }]
            }),
            stderr: ""
          }
        }
      })
      const result = yield* runAudit({ root: fixture.root, mode: "check" }).pipe(
        Effect.provide(makeRunnerLayer(fixture.responses, []))
      )
      expect(result.candidateCounts["migration-debt"]).toBe(1)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("filters unindexed grep paths and rejects duplicate normalized index authority", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture({
        baseline: [],
        grepInventory: [],
        responseOverrides: {
          "grep-json": {
            exitCode: 0,
            stdout: grepOutput({
              file: "./untracked/generated.ts",
              text: "async function ignored() {}\n",
              submatches: [{ text: "async", start: 0, end: 5 }]
            }),
            stderr: ""
          }
        }
      })
      yield* runAudit({ root: fixture.root, mode: "check" }).pipe(
        Effect.provide(makeRunnerLayer(fixture.responses, []))
      )

      const duplicate = `${fixture.indexedFiles.join("\0")}\0./src/main.ts\0`
      const error = yield* runAudit({ root: fixture.root, mode: "check" }).pipe(
        Effect.provide(makeRunnerLayer({
          ...fixture.responses,
          "tracked-files": { exitCode: 0, stdout: duplicate, stderr: "" },
          "tracked-modes": {
            exitCode: 0,
            stdout: `${fixture.responses["tracked-modes"].stdout}100644 0000000000000000000000000000000000000000 0\t./src/main.ts\0`,
            stderr: ""
          }
        }, [])),
        Effect.flip
      )
      expect(error.reason).toBe("invalid-output")
      expect(error.detail).toContain("manifests")
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects malformed grep match payloads, text branches, and byte offsets", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture({ baseline: [], grepInventory: [] })
      const valid = {
        type: "match",
        data: {
          path: { text: "./src/main.ts" },
          lines: { text: "export async function load() { return 1 }\n" },
          line_number: 1,
          absolute_offset: 0,
          submatches: [{ match: { text: "async" }, start: 7, end: 12 }]
        }
      }
      const invalidEvents = [
        { ...valid, data: { ...valid.data, path: { bytes: "c3JjL21haW4udHM=" } } },
        { ...valid, data: { ...valid.data, line_number: null } },
        { ...valid, data: { ...valid.data, submatches: [{ match: { text: "async" }, start: 7.5, end: 12 }] } },
        { ...valid, data: { ...valid.data, submatches: [{ match: { text: "await" }, start: 7, end: 12 }] } },
        { ...valid, data: { ...valid.data, submatches: [{ match: { text: "async" }, start: 7, end: 200 }] } }
      ]
      for (const event of invalidEvents) {
        const encodedEvent = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(event)
        const stdout = `${encodedEvent}\n${grepSummary()}`
        const error = yield* runAudit({ root: fixture.root, mode: "check" }).pipe(
          Effect.provide(makeRunnerLayer({
            ...fixture.responses,
            "grep-json": { exitCode: 0, stdout, stderr: "" }
          }, [])),
          Effect.flip
        )
        expect(error.reason).toBe("invalid-output")
        expect(error.detail).toContain("grep-json")
      }
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("accepts each analyzer-backed reviewed classification and rejects mismatches", () =>
    Effect.gen(function*() {
      const cases = [{
        classification: "host-boundary" as const,
        file: "./scripts/effect-audit.ts",
        source: hostSource,
        line: 3,
        lineText: "NodeRuntime.runMain(Effect.void)\n",
        absoluteOffset: hostSource.indexOf("NodeRuntime.runMain"),
        text: "NodeRuntime.runMain",
        start: 0,
        candidate: makeCandidate({
          file: "scripts/effect-audit.ts",
          declaration: "module:<module>",
          construct: "runner:NodeRuntime.runMain",
          classification: "host-boundary",
          rationale: "Exact permanent Node audit entrypoint",
          line: 3,
          excerpt: "NodeRuntime.runMain(Effect.void)"
        })
      }, {
        classification: "host-required-type" as const,
        file: "./src/main.ts",
        source: "export interface Api { load(): Promise<string> }\n",
        line: 1,
        lineText: "export interface Api { load(): Promise<string> }\n",
        absoluteOffset: 0,
        text: "Promise<",
        start: 31,
        candidate: makeCandidate({
          declaration: "interface:Api.load",
          construct: "promise-type:Promise",
          classification: "host-required-type",
          rationale: "Reviewed host protocol requires a Promise return signature",
          line: 1,
          excerpt: "export interface Api { load(): Promise<string> }"
        })
      }, {
        classification: "audit-fixture" as const,
        file: "./src/main.ts",
        source: "invalidCase(\"async function load() {}\")\n",
        line: 1,
        lineText: "invalidCase(\"async function load() {}\")\n",
        absoluteOffset: 0,
        text: "async",
        start: 13,
        candidate: makeCandidate({
          declaration: "module:<module>",
          construct: "lexical:async",
          classification: "audit-fixture",
          rationale: "Exact source string passed to the audit fixture helper",
          line: 1,
          excerpt: "invalidCase(\"async function load() {}\")"
        })
      }, {
        classification: "false-positive" as const,
        file: "./src/main.ts",
        source: "import { Effect } from \"effect\"\nexport const recover = Effect.catch(value)\n",
        line: 2,
        lineText: "export const recover = Effect.catch(value)\n",
        absoluteOffset: 32,
        text: ".catch(",
        start: 29,
        candidate: makeCandidate({
          declaration: "variable:recover",
          construct: "lexical:.catch(",
          classification: "false-positive",
          rationale: "Analyzer proves the receiver is the Effect module",
          line: 2,
          excerpt: "export const recover = Effect.catch(value)"
        })
      }] as const

      for (const testCase of cases) {
        const fixture = yield* makeFixture({
          baseline: [],
          grepInventory: [testCase.candidate],
          ...(testCase.file === "./src/main.ts" ? { mainSource: testCase.source } : {}),
          responseOverrides: {
            "grep-json": {
              exitCode: 0,
              stdout: grepOutput({
                file: testCase.file,
                line: testCase.line,
                absoluteOffset: testCase.absoluteOffset,
                text: testCase.lineText,
                submatches: [{ text: testCase.text, start: testCase.start, end: testCase.start + utf8Length(testCase.text) }]
              }),
              stderr: ""
            }
          }
        })
        const result = yield* runAudit({ root: fixture.root, mode: "check" }).pipe(
          Effect.provide(makeRunnerLayer(fixture.responses, []))
        )
        expect(result.candidateCounts[testCase.classification]).toBe(1)
      }

      const source = "export async function load() { return 1 }\n"
      for (const classification of ["host-boundary", "host-required-type", "audit-fixture", "false-positive"] as const) {
        const fixture = yield* makeFixture({
          baseline: [],
          grepInventory: [makeCandidate({ classification, rationale: "Claimed evidence" })],
          responseOverrides: {
            "grep-json": {
              exitCode: 0,
              stdout: grepOutput({
                text: source,
                submatches: [{ text: "async", start: 7, end: 12 }]
              }),
              stderr: ""
            }
          }
        })
        const error = yield* runAudit({ root: fixture.root, mode: "check" }).pipe(
          Effect.provide(makeRunnerLayer(fixture.responses, [])),
          Effect.flip
        )
        expect(error.reason).toBe("invalid-output")
        expect(error.detail).toContain(classification)
      }
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("requires nonblank rationale for every reviewed classification", () =>
    Effect.gen(function*() {
      const output = grepOutput({
        file: "./scripts/effect-audit.ts",
        line: 3,
        absoluteOffset: hostSource.indexOf("NodeRuntime.runMain"),
        text: "NodeRuntime.runMain(Effect.void)\n",
        submatches: [{ text: "NodeRuntime.runMain", start: 0, end: 19 }]
      })
      const fixture = yield* makeFixture({
        baseline: [],
        grepInventory: [makeCandidate({
          file: "scripts/effect-audit.ts",
          declaration: "module:<module>",
          construct: "runner:NodeRuntime.runMain",
          classification: "host-boundary",
          rationale: "   ",
          line: 3,
          excerpt: "NodeRuntime.runMain(Effect.void)"
        })],
        responseOverrides: { "grep-json": { exitCode: 0, stdout: output, stderr: "" } }
      })
      const error = yield* runAudit({ root: fixture.root, mode: "check" }).pipe(
        Effect.provide(makeRunnerLayer(fixture.responses, [])),
        Effect.flip
      )
      expect(error.reason).toBe("invalid-output")
      expect(error.detail).toContain("rationale")
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
