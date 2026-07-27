import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, Exit, FileSystem, Layer, Path, Schema } from "effect"
import { describe, expect } from "vitest"
import { AuditFinding, EffectAuditError } from "./effect-audit-model"
import {
  AuditCommandRunner,
  AuditCommandRunnerLive,
  type AuditCommandRequest,
  type AuditCommandResult,
  runAudit
} from "./effect-audit"

const finding = (overrides: Partial<AuditFinding> = {}) => new AuditFinding({
  engine: "effect-language-service",
  file: "src/example.ts",
  rule: "asyncFunction",
  declaration: "variable:load",
  construct: "diagnostic:asyncFunction",
  occurrence: 0,
  severity: "error",
  line: 1,
  excerpt: "export const load = async () => value",
  ...overrides
})

const boundaryFiles = [
  "apps/cli/cli/main.ts",
  "apps/server/main.ts",
  "scripts/effect-audit.ts"
] as const

const boundarySource = 'import { NodeRuntime } from "@effect/platform-node"\ndeclare const program: never\nNodeRuntime.runMain(program)\n'

interface FixtureOptions {
  readonly inventory?: ReadonlyArray<GrepCandidate> | string | undefined
  readonly omitInventory?: boolean | undefined
  readonly grepJson?: string | undefined
  readonly recordGrepRequest?: boolean | undefined
  readonly sampleFile?: string | undefined
  readonly source?: string | undefined
  readonly languageService?: string | undefined
  readonly eslint?: string | undefined
  readonly omitTypeScript?: boolean | undefined
  readonly omitEslint?: boolean | undefined
  readonly result?: Partial<Record<AuditCommandRequest["name"], Partial<AuditCommandResult>>> | undefined
  readonly fail?: AuditCommandRequest["name"] | undefined
}

const withAuditFixture = Effect.fn("EffectAuditTest.withAuditFixture")(
  function* <A>(
    options: FixtureOptions,
    use: (input: {
      readonly root: string
      readonly requests: Array<AuditCommandRequest>
    }) => Effect.Effect<A, unknown, AuditCommandRunner | FileSystem.FileSystem | Path.Path>
  ) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "expand-effect-audit-" })
    const sample = options.sampleFile ?? "src/sample.ts"
    const source = options.source ?? "export const sample = 1\n"
    const tracked = [...allBoundaryFiles, sample]

    for (const file of tracked) {
      yield* fs.makeDirectory(path.dirname(path.join(root, file)), { recursive: true })
      yield* fs.writeFileString(path.join(root, file), file === sample ? source : boundarySource)
    }
    yield* fs.writeFileString(
      path.join(root, "tsconfig.effect-audit.json"),
      yield* Schema.encodeEffect(Schema.UnknownFromJsonString)({
        compilerOptions: { strict: true },
        include: ["**/*.ts", "**/*.tsx"]
      })
    )
    for (const file of allBoundaryFiles) {
      yield* fs.writeFileString(path.join(root, file), boundarySourceCatalog[file]!)
    }
    yield* fs.makeDirectory(path.join(root, "node_modules/electron"), { recursive: true })
    yield* fs.writeFileString(path.join(root, "node_modules/electron/package.json"), '{"types":"index.d.ts"}')
    yield* fs.writeFileString(path.join(root, "node_modules/electron/index.d.ts"), electronTypeSource)

    if (!options.omitInventory) {
      const inventory = options.inventory ?? []
      const encoded = typeof inventory === "string"
        ? inventory
        : yield* Schema.encodeEffect(GrepInventoryJson)([...inventory])
      yield* fs.writeFileString(path.join(root, "effect-grep-inventory.json"), encoded)
    }

    const typeScriptFiles = (options.omitTypeScript ? tracked.filter((file) => file !== sample) : tracked)
      .map((file) => path.join(root, file))
      .join("\n")
    const eslintFiles = (options.omitEslint ? tracked.filter((file) => file !== sample) : tracked)
      .map((file) => ({ filePath: path.join(root, file), messages: [] }))
    const defaults: Record<AuditCommandRequest["name"], AuditCommandResult> = {
      "language-service": { exitCode: 0, stdout: options.languageService ?? '{"diagnostics":[]}', stderr: "" },
      eslint: {
        exitCode: 0,
        stdout: options.eslint ?? (yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(eslintFiles)),
        stderr: ""
      },
      "typescript-files": { exitCode: 0, stdout: `${typeScriptFiles}\n`, stderr: "" },
      "tracked-files": { exitCode: 0, stdout: `${tracked.join("\0")}\0`, stderr: "" },
      "grep-json": { exitCode: 0, stdout: options.grepJson ?? grepJson(), stderr: "" }
    }
    const requests: Array<AuditCommandRequest> = []
    const runner = Layer.succeed(AuditCommandRunner, AuditCommandRunner.of({
      run: (request) => Effect.suspend(() => {
        if (request.name !== "grep-json" || options.recordGrepRequest) requests.push(request)
        if (options.fail === request.name) {
          return Effect.fail(new EffectAuditError({
            reason: "command-failed",
            findings: [],
            detail: `${request.name} interrupted by SIGTERM`
          }))
        }
        return Effect.succeed({ ...defaults[request.name], ...options.result?.[request.name] })
      })
    }))


    return yield* use({ root, requests }).pipe(Effect.provide(runner))
  }
)

const fixture = <A>(
  options: FixtureOptions,
  use: Parameters<typeof withAuditFixture<A>>[1]
) => withAuditFixture(options, use).pipe(Effect.scoped, Effect.provide(NodeServices.layer))


describe("Effect audit command", () => {
  it.effect("runs the exact repository commands through the injectable service", () =>
    fixture({}, ({ root, requests }) =>
      Effect.gen(function*() {
        const result = yield* runAudit(root)

        expect(result.findings).toEqual([])
        expect(requests).toEqual([
          {
            name: "language-service",
            command: "effect-language-service",
            args: ["diagnostics", "--project", "tsconfig.effect-audit.json", "--format", "json", "--severity", "error,message"],
            cwd: root,
            acceptedExitCodes: [0, 1]
          },
          {
            name: "eslint",
            command: "eslint",
            args: ["--config", "eslint.effect.config.mjs", ".", "--format", "json"],
            cwd: root,
            acceptedExitCodes: [0, 1]
          },
          {
            name: "typescript-files",
            command: "tsc",
            args: ["--listFilesOnly", "-p", "tsconfig.effect-audit.json"],
            cwd: root,
            acceptedExitCodes: [0]
          },
          {
            name: "tracked-files",
            command: "git",
            args: ["ls-files", "-z"],
            cwd: root,
            acceptedExitCodes: [0]
          }
        ])
      })))

  it.effect("rejects malformed and empty command JSON", () =>
    fixture({ languageService: "{" }, ({ root }) =>
      Effect.gen(function*() {
        const malformed = yield* runAudit(root).pipe(Effect.flip)
        expect(malformed.reason).toBe("invalid-output")
      })).pipe(Effect.andThen(
        fixture({ eslint: "" }, ({ root }) =>
          Effect.gen(function*() {
            const empty = yield* runAudit(root).pipe(Effect.flip)
            expect(empty.reason).toBe("invalid-output")
          }))
      )))

  it.effect("rejects signals, platform failures, and unaccepted exit codes", () =>
    fixture({ fail: "language-service" }, ({ root }) =>
      Effect.gen(function*() {
        const signal = yield* runAudit(root).pipe(Effect.flip)
        expect(signal).toMatchObject({ reason: "command-failed", detail: expect.stringContaining("SIGTERM") })
      })).pipe(Effect.andThen(
        fixture({ result: { eslint: { exitCode: 2 } } }, ({ root }) =>
          Effect.gen(function*() {
            const invalid = yield* runAudit(root).pipe(Effect.flip)
            expect(invalid).toMatchObject({ reason: "command-failed", detail: expect.stringContaining("eslint") })
          }))
      )))

  it.effect("accepts diagnostic exit one only when stdout decodes", () =>
    fixture({ result: { "language-service": { exitCode: 1 } } }, ({ root }) =>
      Effect.gen(function*() {
        yield* runAudit(root)
      })).pipe(Effect.andThen(
        fixture({ languageService: "not-json", result: { "language-service": { exitCode: 1 } } }, ({ root }) =>
          Effect.gen(function*() {
            const error = yield* runAudit(root).pipe(Effect.flip)
            expect(error.reason).toBe("invalid-output")
          }))
      )))

  it.effect("fails when either semantic engine omits an indexed source", () =>
    fixture({ omitTypeScript: true }, ({ root }) =>
      Effect.gen(function*() {
        const typescript = yield* runAudit(root).pipe(Effect.flip)
        expect(typescript).toMatchObject({ reason: "coverage-gap", detail: expect.stringContaining("src/sample.ts") })
      })).pipe(Effect.andThen(
        fixture({ omitEslint: true }, ({ root }) =>
          Effect.gen(function*() {
            const eslint = yield* runAudit(root).pipe(Effect.flip)
            expect(eslint).toMatchObject({ reason: "coverage-gap", detail: expect.stringContaining("src/sample.ts") })
          }))
      )))

  it.effect("normalizes a synthetic added async function as new debt", () => {
    const source = "export const sample = async () => 1\n"
    const diagnostic = JSON.stringify({ diagnostics: [{
      file: "src/sample.ts",
      start: source.indexOf("async"),
      length: 5,
      line: 1,
      column: source.indexOf("async") + 1,
      severity: "error",
      name: "asyncFunction",
      message: "native async"
    }] })
    return fixture({ source, languageService: diagnostic }, ({ root }) =>
      Effect.gen(function*() {
        const error = yield* runAudit(root).pipe(Effect.flip)
        expect(error.reason).toBe("blocking-findings")
        expect(error.findings).toMatchObject([{
          engine: "effect-language-service",
          file: "src/sample.ts",
          rule: "asyncFunction",
          declaration: "variable:sample",
          construct: "diagnostic:asyncFunction",
          severity: "error"
        }])
      }))
  })

  it.effect("returns only exact effectFnOpportunity advisories", () => {
    const source = "export const sample = Effect.succeed(1)\n"
    const advisory = Schema.encodeSync(Schema.UnknownFromJsonString)({ diagnostics: [{
      file: "src/sample.ts",
      start: source.indexOf("Effect"),
      length: 6,
      line: 1,
      column: source.indexOf("Effect") + 1,
      severity: "message",
      name: "effectFnOpportunity",
      message: "Use Effect.fn"
    }] })
    return fixture({ source, languageService: advisory }, ({ root }) =>
      Effect.gen(function*() {
        const result = yield* runAudit(root)

        expect(result.findings).toEqual([])
        expect(result.messages).toMatchObject([{
          engine: "effect-language-service",
          file: "src/sample.ts",
          rule: "effectFnOpportunity",
          severity: "message"
        }])
      }))
  })

  it.effect("rejects unknown language-service messages", () => {
    const source = "export const sample = 1\n"
    const advisory = Schema.encodeSync(Schema.UnknownFromJsonString)({ diagnostics: [{
      file: "src/sample.ts",
      start: 0,
      line: 1,
      severity: "message",
      name: "unknownOpportunity",
      message: "unknown"
    }] })
    return fixture({ source, languageService: advisory }, ({ root }) =>
      Effect.gen(function*() {
        const error = yield* runAudit(root).pipe(Effect.flip)

        expect(error).toMatchObject({ reason: "invalid-output", detail: expect.stringContaining("unknownOpportunity") })
      }))
  })

  it.effect("rejects every ESLint warning", () =>
    fixture({
      eslint: Schema.encodeSync(Schema.UnknownFromJsonString)([
        ...allBoundaryFiles.map((filePath) => ({ filePath, messages: [] })),
        {
          filePath: "src/sample.ts",
          messages: [{
            ruleId: "local/warning",
            severity: 1,
            message: "warning",
            line: 1,
            column: 1
          }]
        }
      ])
    }, ({ root }) =>
      Effect.gen(function*() {
        const error = yield* runAudit(root).pipe(Effect.flip)

        expect(error).toMatchObject({
          reason: "blocking-findings",
          findings: [{ engine: "eslint", rule: "local/warning", severity: "message" }]
        })
      })))

  it.effect("preserves an ESLint identity after a CRLF line terminator", () => {
    const source = "export const a = 1\r\nexport async function load() {}"
    return fixture({
            source,
      eslint: JSON.stringify([
        ...allBoundaryFiles.map((filePath) => ({ filePath, messages: [] })),
        {
          filePath: "src/sample.ts",
          messages: [{
            ruleId: "effect-boundary/effect-boundary",
            severity: 2,
            message: "Use Effect control flow instead of a native async function.",
            messageId: "nativeAsync",
            line: 2,
            column: 8
          }]
        }
      ])
    }, ({ root }) =>
      Effect.gen(function*() {
        const error = yield* runAudit(root).pipe(Effect.flip)

        expect(error).toMatchObject({
          reason: "blocking-findings",
          findings: [{
            engine: "eslint",
            file: "src/sample.ts",
            rule: "nativeAsync",
            declaration: "function:load",
            construct: "native:async",
            occurrence: 0,
            severity: "error",
            line: 2,
            excerpt: "export async function load() {}"
          }]
        })
      }))
  })

  it.effect("rejects ESLint severities outside one and two", () =>
    Effect.forEach([0, 3], (severity) => fixture({
            eslint: JSON.stringify([
        ...allBoundaryFiles.map((filePath) => ({ filePath, messages: [] })),
        {
          filePath: "src/sample.ts",
          messages: [{
            ruleId: "effect-boundary/effect-boundary",
            severity,
            message: "invalid severity",
            line: 1,
            column: 1
          }]
        }
      ])
    }, ({ root }) =>
      Effect.gen(function*() {
        const error = yield* runAudit(root).pipe(Effect.flip)
        expect(error).toMatchObject({ _tag: "EffectAuditError", reason: "invalid-output" })
      }))))

  it.effect("accepts the valid fatal ESLint message shape", () =>
    fixture({
            eslint: JSON.stringify([
        ...allBoundaryFiles.map((filePath) => ({ filePath, messages: [] })),
        {
          filePath: "src/sample.ts",
          messages: [{
            ruleId: null,
            severity: 2,
            message: "Parsing error",
            line: 1,
            column: 1,
            fatal: true
          }]
        }
      ])
    }, ({ root }) =>
      Effect.gen(function*() {
        const error = yield* runAudit(root).pipe(Effect.flip)
        expect(error).toMatchObject({
          reason: "blocking-findings",
          findings: [{
            engine: "eslint",
            rule: "unknown",
            severity: "error"
          }]
        })
      })))
})

describe("live audit command runner", () => {
  it.effect("drains large stdout and stderr concurrently", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "expand-effect-runner-" })
      const runner = yield* AuditCommandRunner
      const result = yield* runner.run({
        name: "eslint",
        command: "node",
        args: ["-e", 'globalThis.process.stdout.write("o".repeat(300000));globalThis.process.stderr.write("e".repeat(300000))'],
        cwd: root,
        acceptedExitCodes: [0]
      })

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toHaveLength(300000)
      expect(result.stderr).toHaveLength(300000)
    }).pipe(
      Effect.scoped,
      Effect.provide(AuditCommandRunnerLive),
      Effect.provide(NodeServices.layer)
    ))

  it.effect("turns a child-process signal into a typed command failure", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "expand-effect-signal-" })
      const runner = yield* AuditCommandRunner
      const exit = yield* runner.run({
        name: "eslint",
        command: "node",
        args: ["-e", 'globalThis.process.kill(globalThis.process.pid,"SIGTERM")'],
        cwd: root,
        acceptedExitCodes: [0]
      }).pipe(Effect.exit)

      const failure = Exit.findError(exit)
      expect(failure._tag).toBe("Success")
      if (failure._tag === "Success") {
        expect(failure.success).toMatchObject({ _tag: "EffectAuditError", reason: "command-failed" })
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(AuditCommandRunnerLive),
      Effect.provide(NodeServices.layer)
    ))

  it.effect("turns an executable-not-found platform error into a typed command failure", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "expand-effect-missing-command-" })
      const runner = yield* AuditCommandRunner
      const exit = yield* runner.run({
        name: "eslint",
        command: "expand-effect-audit-command-that-does-not-exist",
        args: [],
        cwd: root,
        acceptedExitCodes: [0]
      }).pipe(Effect.exit)

      const failure = Exit.findError(exit)
      expect(failure._tag).toBe("Success")
      if (failure._tag === "Success") {
        expect(failure.success).toMatchObject({ _tag: "EffectAuditError", reason: "command-failed" })
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(AuditCommandRunnerLive),
      Effect.provide(NodeServices.layer)
    ))
})

import {
  GrepCandidate,
  GrepInventoryJson,
  compareGrepInventory,
  grepCandidateKey,
  grepInventoryValidationError,
} from "./effect-inventory-model"
import { EFFECT_GREP_ARGS, utf8ByteOffsetToCodeUnit } from "./effect-audit"

const candidate = (overrides: Partial<GrepCandidate> = {}) => new GrepCandidate({
  file: "src/example.ts",
  declaration: "variable:load",
  construct: "lexical:async",
  occurrence: 0,
  classification: "migration-debt",
  rationale: "",
  line: 1,
  excerpt: "export const load = async () => value",
  ...overrides
})

const grepMatch = (
  file: string,
  lines: string,
  lineNumber: number,
  match: string,
  start = new TextEncoder().encode(lines.slice(0, lines.indexOf(match))).length,
  absoluteOffset = 0
) => ({
  type: "match",
  data: {
    path: { text: file },
    lines: { text: lines },
    line_number: lineNumber,
    absolute_offset: absoluteOffset,
    submatches: [{ match: { text: match }, start, end: start + new TextEncoder().encode(match).length }]
  }
})

const byteOffsetAtLine = (source: string, lineNumber: number) => {
  let offset = 0
  for (let line = 1; line < lineNumber; line += 1) {
    const next = source.indexOf("\n", offset)
    if (next < 0) return new TextEncoder().encode(source).length
    offset = next + 1
  }
  return new TextEncoder().encode(source.slice(0, offset)).length
}

const grepJson = (...matches: ReadonlyArray<ReturnType<typeof grepMatch>>) =>
  [...matches, { type: "summary", data: {} }].map((event) => JSON.stringify(event)).join("\n")

describe("Effect grep inventory model", () => {
  it("keys records only by file, declaration, construct, and occurrence", () => {
    const original = candidate()
    const displayMoved = candidate({
      rationale: "reviewed rationale",
      line: 400,
      excerpt: "export   const load=async()=>value"
    })

    expect(grepCandidateKey(original)).toBe(grepCandidateKey(displayMoved))
    expect(compareGrepInventory([original], [displayMoved])).toEqual({
      added: [],
      removed: [],
      reclassified: []
    })
  })

  it("rejects duplicate and unstably ordered identities", () => {
    const first = candidate({ occurrence: 0 })
    const second = candidate({ occurrence: 1 })

    expect(grepInventoryValidationError([second, first])).toContain("sorted")
    expect(grepInventoryValidationError([first, candidate({ line: 99 })])).toContain("duplicate")
    expect(grepInventoryValidationError([first, second])).toBeUndefined()
  })

  it("detects additions, moves, stale records, and implicit reclassification", () => {
    const original = candidate()
    const added = candidate({ occurrence: 1 })
    const moved = candidate({ declaration: "variable:renamed" })
    const reclassified = candidate({ classification: "false-positive", rationale: "Effect method" })

    expect(compareGrepInventory([original], [original, added])).toMatchObject({ added: [added] })
    expect(compareGrepInventory([original], [])).toMatchObject({ removed: [original] })
    expect(compareGrepInventory([original], [moved])).toMatchObject({ added: [moved], removed: [original] })
    expect(compareGrepInventory([original], [reclassified])).toMatchObject({ reclassified: [reclassified] })
  })

  it("rejects classifications outside the closed schema", () => {
    expect(() => Schema.decodeUnknownSync(GrepCandidate)({
      ...candidate(),
      classification: "approved"
    })).toThrow()
  })

  it("converts ripgrep UTF-8 byte offsets to JavaScript UTF-16 offsets", () => {
    const source = "const marker = '😀'; async () => 1"
    const codeUnitOffset = source.indexOf("async")
    const byteOffset = new TextEncoder().encode(source.slice(0, codeUnitOffset)).length

    expect(utf8ByteOffsetToCodeUnit(source, byteOffset)).toBe(codeUnitOffset)
    expect(utf8ByteOffsetToCodeUnit("😀async", 4)).toBe(2)
    expect(utf8ByteOffsetToCodeUnit("😀async", 999)).toBe(7)
  })
})

describe("Effect grep inventory command", () => {
  it.effect("rejects a missing grep inventory", () =>
    fixture({ omitInventory: true }, ({ root }) =>
      Effect.gen(function*() {
        const error = yield* runAudit(root).pipe(Effect.flip)

        expect(error).toMatchObject({ reason: "invalid-output", detail: expect.stringContaining("effect-grep-inventory.json") })
      })))

  it.effect("uses the approved grep expression and globs with JSON output and an explicit machine root", () =>
    fixture({ recordGrepRequest: true }, ({ root, requests }) =>
      Effect.gen(function*() {
        yield* runAudit(root)
        expect(requests.at(-1)).toEqual({
          name: "grep-json",
          command: "rg",
          args: ["--json", ...EFFECT_GREP_ARGS, "."],
          cwd: root,
          acceptedExitCodes: [0, 1]
        })
        expect(EFFECT_GREP_ARGS).toEqual([
          "-n",
          "--hidden",
          "-g",
          "*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
          "-g",
          "!.git/**",
          "-g",
          "!**/node_modules/**",
          "-g",
          "!**/{dist,out,build,coverage,test-results,playwright-report}/**",
          String.raw`\basync\b|\bawait\b|new\s+Promise\b|\bPromise(?:Like)?\s*<|\bPromise\.(?:all|allSettled|any|race|resolve|reject)\b|\.(?:then|catch|finally)\s*\(|\b(?:setTimeout|setInterval|setImmediate|queueMicrotask|fetch)\s*\(|new\s+(?:Date|WebSocket|Worker|MessageChannel|BroadcastChannel)\s*\(|\b(?:console\.\w+|Date\.now|performance\.now|Math\.random|crypto\.randomUUID|JSON\.(?:parse|stringify)|process\.[A-Za-z_$][A-Za-z0-9_$]*|(?:window|document|navigator|localStorage|sessionStorage)\.)|\bnode:[^'"[:space:]]+|\b[A-Za-z_$][A-Za-z0-9_$]*\.run(?:Promise(?:Exit)?|Sync(?:Exit)?|Fork|Callback|Main)\b`
        ])
      })))

  it.effect("rejects malformed ripgrep events and accepts a decoded exit one summary", () =>
    fixture({ grepJson: "{" }, ({ root }) =>
      Effect.gen(function*() {
        const malformed = yield* runAudit(root).pipe(Effect.flip)
        expect(malformed.reason).toBe("invalid-output")
      })).pipe(Effect.andThen(
        fixture({ result: { "grep-json": { exitCode: 1 } } }, ({ root }) =>
          runAudit(root).pipe(Effect.asVoid)
        )
      )))

  it.effect("filters grep output to uniquely tracked and indexed first-party source paths", () =>
    fixture({
            grepJson: grepJson(grepMatch("src/untracked.ts", "export const load = async () => 1\n", 1, "async"))
    }, ({ root }) =>
      Effect.gen(function*() {
        const result = yield* runAudit(root)
        expect(result.grepCandidates).toEqual([])
      })))

  it.effect("fails on a new unclassified grep submatch", () => {
    const source = "export const sample = async () => 1\n"
    return fixture({
            source,
      grepJson: grepJson(grepMatch("src/sample.ts", source, 1, "async"))
    }, ({ root }) =>
      Effect.gen(function*() {
        const error = yield* runAudit(root).pipe(Effect.flip)
        expect(error).toMatchObject({ reason: "invalid-output", detail: expect.stringContaining("grep inventory") })
      }))
  })

  it.effect("accepts an exact permanent host-boundary classification", () => {
    const reviewed = candidate({
      file: "apps/cli/cli/main.ts",
      declaration: "module:<module>",
      construct: "runner:NodeRuntime.runMain",
      classification: "host-boundary",
      rationale: "Node application entrypoint",
      line: 3,
      excerpt: "NodeRuntime.runMain(program)"
    })
    return fixture({
            inventory: [reviewed],
      grepJson: grepJson(grepMatch(
        "apps/cli/cli/main.ts",
        "NodeRuntime.runMain(program)\n",
        3,
        "NodeRuntime.runMain",
        undefined,
        byteOffsetAtLine(boundarySource, 3)
      ))
    }, ({ root }) => runAudit(root).pipe(Effect.asVoid))
  })

  it.effect("accepts analyzer-proven host-required types, audit fixtures, and lexical false positives", () => {
    const hostTypeSource = "export type Loader = () => Promise<string>\n"
    const hostType = candidate({
      file: "src/sample.ts",
      declaration: "type:Loader",
      construct: "signature:PromiseLike",
      classification: "host-required-type",
      rationale: "Required host Promise signature",
      excerpt: hostTypeSource.trim()
    })
    const fixtureSource = "export const fixture = \"async () => value\"\n"
    const auditFixture = candidate({
      file: "test/sample.test.ts",
      declaration: "variable:fixture",
      construct: "lexical:async",
      classification: "audit-fixture",
      rationale: "Effect audit source fixture",
      excerpt: fixtureSource.trim()
    })
    const falsePositiveSource = "import { Effect } from \"effect\"\nexport const sample = Effect.catch(Effect.succeed(1), () => Effect.succeed(2))\n"
    const falsePositiveLine = "export const sample = Effect.catch(Effect.succeed(1), () => Effect.succeed(2))\n"
    const falsePositive = candidate({
      file: "src/sample.ts",
      declaration: "variable:sample",
      construct: "lexical:.catch(",
      classification: "false-positive",
      rationale: "Effect.catch is Effect composition",
      line: 2,
      excerpt: falsePositiveLine.trim()
    })

    return fixture({
            inventory: [hostType],
      source: hostTypeSource,
      grepJson: grepJson(grepMatch("src/sample.ts", hostTypeSource, 1, "Promise<"))
    }, ({ root }) => runAudit(root).pipe(Effect.asVoid)).pipe(
      Effect.andThen(fixture({
                inventory: [auditFixture],
        sampleFile: "test/sample.test.ts",
        source: fixtureSource,
        grepJson: grepJson(grepMatch("test/sample.test.ts", fixtureSource, 1, "async"))
      }, ({ root }) => runAudit(root).pipe(Effect.asVoid))),
      Effect.andThen(fixture({
                inventory: [falsePositive],
        source: falsePositiveSource,
        grepJson: grepJson(grepMatch(
          "src/sample.ts",
          falsePositiveLine,
          2,
          ".catch(",
          undefined,
          byteOffsetAtLine(falsePositiveSource, 2)
        ))
      }, ({ root }) => runAudit(root).pipe(Effect.asVoid)))
    )
  })

  it.effect("admits string-literal false positives only from the exact executable inventory analyzer", () => {
    const runner = ["NodeRuntime", ".runMain"].join("")
    const source = `const resolveAlias = () => "runner:${runner}"\n`
    const reviewed = (file: string) => candidate({
      file,
      declaration: "variable:resolveAlias",
      construct: `lexical:${runner}`,
      classification: "false-positive",
      rationale: ["String literal runner identity, not a Runtime", ".runMain execution boundary"].join(""),
      excerpt: source.trim()
    })
    const run = (file: string) => fixture({
            inventory: [reviewed(file)],
      sampleFile: file,
      source,
      grepJson: grepJson(grepMatch(file, source, 1, runner))
    }, ({ root }) => runAudit(root))

    return run("scripts/effect-executable-inventory.ts").pipe(
      Effect.asVoid,
      Effect.andThen(run("scripts/effect-executable-inventory-helper.ts").pipe(
        Effect.flip,
        Effect.tap((error) => Effect.sync(() => expect(error).toMatchObject({ reason: "invalid-output", detail: expect.stringContaining("false-positive") })))
      )),
      Effect.andThen(run("src/effect-executable-inventory.ts").pipe(
        Effect.flip,
        Effect.tap((error) => Effect.sync(() => expect(error).toMatchObject({ reason: "invalid-output", detail: expect.stringContaining("false-positive") })))
      )),
      Effect.asVoid
    )
  })

  it.effect("rejects unsupported classification proof and empty non-debt rationales", () => {
    const source = "export const sample = async () => 1\n"
    const match = grepJson(grepMatch("src/sample.ts", source, 1, "async"))
    const falsePositive = candidate({
      file: "src/sample.ts",
      declaration: "variable:sample",
      construct: "native:async",
      classification: "false-positive",
      rationale: "native async is executable"
    })
    const emptyRationale = candidate({
      file: "src/sample.ts",
      declaration: "variable:sample",
      construct: "native:async",
      classification: "host-required-type",
      rationale: "   "
    })

    return fixture({ inventory: [falsePositive], source, grepJson: match }, ({ root }) =>
      Effect.gen(function*() {
        const error = yield* runAudit(root).pipe(Effect.flip)
        expect(error).toMatchObject({ reason: "invalid-output", detail: expect.stringContaining("false-positive") })
      })).pipe(Effect.andThen(
        fixture({ inventory: [emptyRationale], source, grepJson: match }, ({ root }) =>
          Effect.gen(function*() {
            const error = yield* runAudit(root).pipe(Effect.flip)
            expect(error).toMatchObject({ reason: "invalid-output", detail: expect.stringContaining("rationale") })
          }))
      ))
  })
})

describe("Effect grep inventory hardening", () => {
  it.effect("rejects computed permanent boundaries stored as debt", () => {
    const entrypoint = ["NodeRuntime", ".runMain"].join("")
    const construct = ["runner:NodeRuntime", ".runMain"].join("")
    const lines = `${boundarySource.split("\n").at(-2) ?? ""}\n`
    const stored = candidate({
      file: "apps/cli/cli/main.ts",
      declaration: "module:<module>",
      construct,
      classification: "migration-debt",
      rationale: "",
      line: 3,
      excerpt: lines.trim()
    })
    return fixture({
            inventory: [stored],
      grepJson: grepJson(grepMatch(
        "apps/cli/cli/main.ts",
        lines,
        3,
        entrypoint,
        undefined,
        byteOffsetAtLine(boundarySource, 3)
      ))
    }, ({ root }) =>
      Effect.gen(function*() {
        const error = yield* runAudit(root).pipe(Effect.flip)

        expect(error).toMatchObject({
          reason: "invalid-output",
          detail: expect.stringContaining("reclassifications")
        })
      }))
  })

  it.effect("rejects inconsistent and out-of-range source line numbers", () => {
    const keyword = ["as", "ync"].join("")
    const first = "export const marker = 1\n"
    const second = `export const sample = ${keyword} () => 1\n`
    const source = first + second
    const valid = grepMatch(
      "src/sample.ts",
      second,
      2,
      keyword,
      undefined,
      byteOffsetAtLine(source, 2)
    )
    const inconsistent = { ...valid, data: { ...valid.data, line_number: 1 } }
    const outOfRange = { ...valid, data: { ...valid.data, line_number: 3 } }
    return fixture({ source, grepJson: grepJson(inconsistent) }, ({ root }) =>
      Effect.gen(function*() {
        const error = yield* runAudit(root).pipe(Effect.flip)
        expect(error.reason).toBe("invalid-output")
      })).pipe(Effect.andThen(
        fixture({ source, grepJson: grepJson(outOfRange) }, ({ root }) =>
          Effect.gen(function*() {
            const error = yield* runAudit(root).pipe(Effect.flip)
            expect(error.reason).toBe("invalid-output")
          }))
      ))
  })

  it.effect("rejects incorrect byte origins and indexed line text", () => {
    const keyword = ["as", "ync"].join("")
    const first = "export const marker = 1\n"
    const second = `export const sample = ${keyword} () => 1\n`
    const source = first + second
    const valid = grepMatch(
      "src/sample.ts",
      second,
      2,
      keyword,
      undefined,
      byteOffsetAtLine(source, 2)
    )
    const wrongOffset = { ...valid, data: { ...valid.data, absolute_offset: 0 } }
    const wrongLines = second.replace("sample", "change")
    const wrongText = grepMatch(
      "src/sample.ts",
      wrongLines,
      2,
      keyword,
      undefined,
      byteOffsetAtLine(source, 2)
    )
    return fixture({ source, grepJson: grepJson(wrongOffset) }, ({ root }) =>
      Effect.gen(function*() {
        const error = yield* runAudit(root).pipe(Effect.flip)
        expect(error.reason).toBe("invalid-output")
      })).pipe(Effect.andThen(
        fixture({ source, grepJson: grepJson(wrongText) }, ({ root }) =>
          Effect.gen(function*() {
            const error = yield* runAudit(root).pipe(Effect.flip)
            expect(error.reason).toBe("invalid-output")
          }))
      ))
  })

  it.effect("rejects byte spans outside a line or inside a multibyte character", () => {
    const keyword = ["as", "ync"].join("")
    const source = `export const marker = "😀"; export const sample = ${keyword} () => 1\n`
    const valid = grepMatch("src/sample.ts", source, 1, keyword)
    const byteLength = new TextEncoder().encode(source).length
    const splitPoint = new TextEncoder().encode(source.slice(0, source.indexOf("😀"))).length + 1
    const outOfRange = {
      ...valid,
      data: {
        ...valid.data,
        submatches: [{ match: { text: "" }, start: byteLength, end: byteLength + 1 }]
      }
    }
    const splitCharacter = {
      ...valid,
      data: {
        ...valid.data,
        submatches: [{ match: { text: "" }, start: splitPoint, end: splitPoint }]
      }
    }
    return fixture({ source, grepJson: grepJson(outOfRange) }, ({ root }) =>
      Effect.gen(function*() {
        const error = yield* runAudit(root).pipe(Effect.flip)
        expect(error.reason).toBe("invalid-output")
      })).pipe(Effect.andThen(
        fixture({ source, grepJson: grepJson(splitCharacter) }, ({ root }) =>
          Effect.gen(function*() {
            const error = yield* runAudit(root).pipe(Effect.flip)
            expect(error.reason).toBe("invalid-output")
          }))
      ))
  })

  it.effect("rejects duplicate lexical source coordinates", () => {
    const method = [".ca", "tch("].join("")
    const source = `import { Effect } from "effect"\nexport const sample = Effect${method}Effect.succeed(1), () => Effect.succeed(2))\n`
    const lines = source.slice(source.indexOf("\n") + 1)
    const event = grepMatch(
      "src/sample.ts",
      lines,
      2,
      method,
      undefined,
      byteOffsetAtLine(source, 2)
    )
    return fixture({ source, grepJson: grepJson(event, event) }, ({ root }) =>
      Effect.gen(function*() {
        const error = yield* runAudit(root).pipe(Effect.flip)
        expect(error.reason).toBe("invalid-output")
      }))
  })

  it.effect("maps a multibyte line to the exact analyzer identity", () => {
    const keyword = ["as", "ync"].join("")
    const construct = ["native:", keyword].join("")
    const source = `export const marker = "😀"; export const load = ${keyword} () => 1\n`
    const stored = candidate({
      file: "src/sample.ts",
      declaration: "variable:load",
      construct,
      occurrence: 0,
      classification: "migration-debt",
      rationale: "",
      line: 1,
      excerpt: source.trim()
    })
    return fixture({
            inventory: [stored],
      source,
      grepJson: grepJson(grepMatch("src/sample.ts", source, 1, keyword))
    }, ({ root }) =>
      Effect.gen(function*() {
        const result = yield* runAudit(root)
        expect(result.grepCandidates).toEqual([stored])
      }))
  })

  it.effect("resolves a match after a standalone carriage return", () => {
    const keyword = ["as", "ync"].join("")
    const construct = ["native:", keyword].join("")
    const source = `export const marker = 1\rexport const sample = ${keyword} () => 1\n`
    const expected = candidate({
      file: "src/sample.ts",
      declaration: "variable:sample",
      construct,
      occurrence: 0,
      line: 1,
      excerpt: source.trim()
    })
    const stored = candidate({
      file: "src/sample.ts",
      declaration: "variable:sample",
      construct,
      occurrence: 0,
      line: 99,
      excerpt: "stale display"
    })
    return fixture({
            inventory: [stored],
      source,
      grepJson: grepJson(grepMatch("src/sample.ts", source, 1, keyword, undefined, 0))
    }, ({ root }) =>
      Effect.gen(function*() {
        const result = yield* runAudit(root)

        expect(result.grepCandidates).toEqual([expected])
      }))
  })

  it.effect("resolves a match on the second CRLF-delimited line", () => {
    const keyword = ["as", "ync"].join("")
    const construct = ["native:", keyword].join("")
    const source = `export const marker = 1\r\nexport const sample = ${keyword} () => 1\n`
    const lines = source.slice(source.indexOf("\n") + 1)
    const absoluteOffset = byteOffsetAtLine(source, 2)
    const expected = candidate({
      file: "src/sample.ts",
      declaration: "variable:sample",
      construct,
      occurrence: 0,
      line: 2,
      excerpt: lines.trim()
    })
    const stored = candidate({
      file: "src/sample.ts",
      declaration: "variable:sample",
      construct,
      occurrence: 0,
      line: 99,
      excerpt: "stale display"
    })
    return fixture({
            inventory: [stored],
      source,
      grepJson: grepJson(grepMatch("src/sample.ts", lines, 2, keyword, undefined, absoluteOffset))
    }, ({ root }) =>
      Effect.gen(function*() {
        const result = yield* runAudit(root)

        expect(result.grepCandidates).toEqual([expected])
      }))
  })

  it.effect("resolves a match after a Unicode line separator", () => {
    const keyword = ["as", "ync"].join("")
    const construct = ["native:", keyword].join("")
    const source = `export const marker = 1\u2028export const sample = ${keyword} () => 1\n`
    const expected = candidate({
      file: "src/sample.ts",
      declaration: "variable:sample",
      construct,
      occurrence: 0,
      line: 1,
      excerpt: source.trim()
    })
    const stored = candidate({
      file: "src/sample.ts",
      declaration: "variable:sample",
      construct,
      occurrence: 0,
      line: 99,
      excerpt: "stale display"
    })
    return fixture({
            inventory: [stored],
      source,
      grepJson: grepJson(grepMatch("src/sample.ts", source, 1, keyword, undefined, 0))
    }, ({ root }) =>
      Effect.gen(function*() {
        const result = yield* runAudit(root)

        expect(result.grepCandidates).toEqual([expected])
      }))
  })

  it.effect("resolves a match after a Unicode paragraph separator", () => {
    const keyword = ["as", "ync"].join("")
    const construct = ["native:", keyword].join("")
    const source = `export const marker = 1\u2029export const sample = ${keyword} () => 1\n`
    const expected = candidate({
      file: "src/sample.ts",
      declaration: "variable:sample",
      construct,
      occurrence: 0,
      line: 1,
      excerpt: source.trim()
    })
    const stored = candidate({
      file: "src/sample.ts",
      declaration: "variable:sample",
      construct,
      occurrence: 0,
      line: 99,
      excerpt: "stale display"
    })
    return fixture({
            inventory: [stored],
      source,
      grepJson: grepJson(grepMatch("src/sample.ts", source, 1, keyword, undefined, 0))
    }, ({ root }) =>
      Effect.gen(function*() {
        const result = yield* runAudit(root)

        expect(result.grepCandidates).toEqual([expected])
      }))
  })
})

import { effectHostBoundaries } from "../eslint-rules/effect-host-boundaries.mjs"

const nodeOs = ["node", "os"].join(":")
const nodeCrypto = ["node", "crypto"].join(":")
const nodeHttp = ["node", "http"].join(":")
const hostProcessArgv = ["process", "argv"].join(".")
const hostProcessCwd = ["process", "cwd"].join(".")
const hostProcessKill = ["process", "kill"].join(".")
const hostProcessMemoryUsage = ["process", "memoryUsage"].join(".")
const hostProcessPid = ["process", "pid"].join(".")
const hostProcessUmask = ["process", "umask"].join(".")
const nodeRuntimeRunMain = ["NodeRuntime", "runMain"].join(".")
const effectRunPromise = ["Effect", "runPromise"].join(".")
const effectRunFork = ["Effect", "runFork"].join(".")
const hostProcessExecPath = ["process", "execPath"].join(".")
const hostProcessPlatform = ["process", "platform"].join(".")
const hostProcessVersion = ["process", "version"].join(".")
const documentGetElementById = ["document", "getElementById"].join(".")
const documentAddEventListener = ["document", "addEventListener"].join(".")
const documentRemoveEventListener = ["document", "removeEventListener"].join(".")
const windowExpand = ["window", "expand"].join(".")
const windowLocation = ["window", "location"].join(".")
const windowPostMessage = ["window", "postMessage"].join(".")
const windowAddEventListener = ["window", "addEventListener"].join(".")
const windowRemoveEventListener = ["window", "removeEventListener"].join(".")
const cryptoRandomUUID = ["crypto", "randomUUID"].join(".")
const promiseType = ["Pro", "mise"].join("")
const promiseLikeType = ["Promise", "Like"].join("")
const nodePath = ["node", "path"].join(":")
const nodeUrl = ["node", "url"].join(":")
const platformProcessCwd = ["platform:process", "cwd"].join(".")
const asyncKeyword = ["as", "ync"].join("")
const nativeAsync = ["native:as", "ync"].join("")

const runnerBoundarySource = `import { NodeRuntime } from "@effect/platform-node"
declare const program: never
${nodeRuntimeRunMain}(program)
`

const bracketRunnerBoundarySource = `import { NodeRuntime } from "@effect/platform-node"
declare const program: never
NodeRuntime["runMain"](program)
`

const dynamicImportBoundarySource = `import { Effect } from "effect"
const module = Effect.promise(() => import("effect"))
void module
`

const appContextBoundarySource = `import { Effect } from "effect"
import { homedir } from "${nodeOs}"
export const nodeAppContext = Effect.fn("NodeAppContext.make")(function*() {
  const homeDir = yield* Effect.try({ try: homedir, catch: String })
  const cwd = yield* Effect.try({ try: () => ${hostProcessCwd}(), catch: String })
  return { homeDir, cwd }
})
`

const serverHttpBoundarySource = `import { timingSafeEqual } from "${nodeCrypto}"
import { createServer } from "${nodeHttp}"
void timingSafeEqual
void createServer
`

const serverMainBoundarySource = `import { NodeRuntime } from "@effect/platform-node"
declare const program: never
${hostProcessUmask}(0o077)
${nodeRuntimeRunMain}(program)
`

const processControlBoundarySource = `export const nodeProcessControlLayer = { currentPid: ${hostProcessPid} }
export const probe = { try: () => ${hostProcessKill}(0, 0) }
`

const electronTypeSource = `export class EventEmitter {
  on(event: string, listener: (...args: Array<any>) => void): this
  off(event: string, listener: (...args: Array<any>) => void): this
}
export class BrowserWindow extends EventEmitter {
  webContents: EventEmitter
  constructor(options?: unknown)
}
export class MessageChannelMain {}
export interface IpcMain {
  on(event: string, listener: (...args: Array<any>) => void): this
  off(event: string, listener: (...args: Array<any>) => void): this
  handle(event: string, listener: (...args: Array<any>) => unknown): void
  removeHandler(event: string): void
}
export interface IpcRenderer {
  on(event: string, listener: (...args: Array<any>) => void): this
  removeListener(event: string, listener: (...args: Array<any>) => void): this
  send(event: string, payload: unknown): void
  invoke(event: string, payload: unknown): ${promiseType}<unknown>
}
export const ipcMain: IpcMain
export const ipcRenderer: IpcRenderer
export const contextBridge: { exposeInMainWorld(key: string, api: unknown): void }
export const app: EventEmitter & {
  isPackaged: boolean
  whenReady(): ${promiseType}<void>
  commandLine: { appendSwitch(name: string, value: string): void }
  disableHardwareAcceleration(): void
  quit(): void
}
export const session: { defaultSession: { webRequest: { onHeadersReceived(listener: unknown): void } } }
export interface Event<T = unknown> { value?: T }
export interface MessagePortMain {}
export interface IpcRendererEvent { ports: Array<MessagePort> }
`

const desktopMainBoundarySource = `import { app, BrowserWindow, MessageChannelMain, session } from "electron"
import type { Event } from "electron"
import { NodeRuntime } from "@effect/platform-node"
const appHost = {
  isPackaged: app.isPackaged,
  ready: app.whenReady(),
  appendSwitch: (name: string, value: string) => app.commandLine.appendSwitch(name, value),
  disableHardwareAcceleration: () => app.disableHardwareAcceleration(),
  onBeforeQuit: (listener: () => void) => { app.on("before-quit", listener); return () => app.off("before-quit", listener) },
  onWindowAllClosed: (listener: () => void) => { app.on("window-all-closed", listener); return () => app.off("window-all-closed", listener) },
  quit: () => app.quit()
}
const csp = {
  onHeadersReceived: (listener: () => void) => {
    session.defaultSession.webRequest.onHeadersReceived(listener)
    return () => session.defaultSession.webRequest.onHeadersReceived(null)
  }
}
const createWindow = () => {
  const browserWindow = new BrowserWindow()
  const webContents = browserWindow.webContents
  return {
    onClosed: (listener: () => void) => { browserWindow.on("closed", listener); return () => browserWindow.off("closed", listener) },
    onNavigation: (listener: () => void) => { webContents.on("did-start-navigation", listener); return () => webContents.off("did-start-navigation", listener) },
    onWillNavigate: (listener: () => void) => { webContents.on("will-navigate", listener); return () => webContents.off("will-navigate", listener) }
  }
}
const deps = { platform: ${hostProcessPlatform}, makeMessageChannel: () => new MessageChannelMain() }
declare const program: never
${nodeRuntimeRunMain}(program)
void appHost
void csp
void createWindow
void deps
void (null as Event | null)
`

const boundarySourceCatalog: Record<string, string> = {
  "apps/cli/cli/main.ts": `${boundarySource}const backendCommand = { execPath: ${hostProcessExecPath}, binaryArgs: [${hostProcessExecPath}] }
void backendCommand
`,
  "apps/cli/cli/node-app-context.ts": appContextBoundarySource,
  "apps/desktop/electron.vite.config.ts": `import { builtinModules } from "node:module"
import { resolve } from "node:path"
void builtinModules
void resolve
`,
  "apps/desktop/e2e/effect-test.ts": `import { Effect } from "effect"
export const makeTestEffect = (): ${promiseLikeType}<void> => ${effectRunPromise}(Effect.void)
`,
  "apps/desktop/src/main/index.ts": desktopMainBoundarySource,
  "apps/desktop/src/main/node-app-context.ts": appContextBoundarySource,
  "apps/desktop/src/renderer/app/runner.ts": `import { Effect } from "effect"
declare const effect: Effect.Effect<void>
const fiber = ${effectRunFork}(effect)
void fiber
`,
  "apps/desktop/src/renderer/main.tsx": `const root = ${documentGetElementById}("root")
const getBridge = () => ${windowExpand}
const retry = () => ${windowLocation}.reload()
const onDispose = (dispose: () => void) => ${windowAddEventListener}("unload", dispose)
const release = (dispose: () => void) => ${windowRemoveEventListener}("unload", dispose)
void root
void getBridge
void retry
void onDispose
void release
`,
  "apps/desktop/src/renderer/features/command/model/use-command-palette-hotkey.ts": `export const useCommandPaletteHotkey = () => {
  const listener = () => undefined
  ${documentAddEventListener}("keydown", listener)
  ${documentRemoveEventListener}("keydown", listener)
}
`,
  "apps/server/http.ts": serverHttpBoundarySource,
  "apps/server/main.ts": serverMainBoundarySource,
  "apps/server/node-app-context.ts": appContextBoundarySource,
  "apps/server/node-process-control.ts": processControlBoundarySource,
  "apps/server/test/fixtures/state-root-lock-contender.ts": runnerBoundarySource,
  "apps/server/test/fixtures/trust-boundary-host.ts": `import { homedir } from "${nodeOs}"
import { NodeRuntime } from "@effect/platform-node"
const program = ${hostProcessUmask}(0o077)
${nodeRuntimeRunMain}(program as never)
void homedir
`,
  "apps/tui/main.tsx": runnerBoundarySource,
  "apps/tui/runtime.ts": `import { join } from "${nodePath}"
import { fileURLToPath } from "${nodeUrl}"
const backendCommand = { execPath: ${hostProcessExecPath}, binaryArgs: [${hostProcessExecPath}] }
void backendCommand
void join
void fileURLToPath
`,
  "apps/tui/node-app-context.ts": appContextBoundarySource,
  "bench/main.ts": `import { cpus } from "${nodeOs}"
import { NodeRuntime } from "@effect/platform-node"
const opts = { try: () => ${hostProcessArgv}.slice(2) }
const benchmarkHostLayer = { rss: () => ${hostProcessMemoryUsage}().rss, nodeVersion: ${hostProcessVersion} }
declare const program: never
${nodeRuntimeRunMain}(program)
void cpus
void opts
void benchmarkHostLayer
`,
  "bench/selfcheck.ts": runnerBoundarySource,
  "examples/client-ts/archive-stale.ts": runnerBoundarySource,
  "examples/client-ts/audit-log.ts": runnerBoundarySource,
  "examples/client-ts/bootstrap-projects.ts": runnerBoundarySource,
  "examples/client-ts/node-app-context.ts": appContextBoundarySource,
  "packages/electron-ipc/contract.ts": `type InvokeChannel<P> = { payload: P }
export type IpcBridgeOf<C> = { [K in keyof C]: C[K] extends InvokeChannel<infer P> ? (payload: P) => ${promiseType}<unknown> : never }
`,
  "packages/electron-ipc/main-electron.ts": `import { ipcMain } from "electron"
import type { MessagePortMain } from "electron"
export const electronBindDeps = {
  on: (listener: () => void) => { ipcMain.on("channel", listener); return () => ipcMain.off("channel", listener) },
  handle: (handler: () => ${promiseType}<unknown>) => {
    const wrapper = (): ${promiseType}<unknown> => handler()
    ipcMain.handle("channel", wrapper)
    return () => ipcMain.removeHandler("channel")
  }
}
void (null as MessagePortMain | null)
`,
  "packages/electron-ipc/main.ts": `export interface IpcMainLike { handle(handler: () => ${promiseType}<unknown>): void }
const invokeHandler = (): ${promiseType}<unknown> => ${promiseType}.resolve()
const runPromise = (): ${promiseType}<unknown> => ${promiseType}.resolve()
const silentInvoke: ${promiseType}<unknown> = ${promiseType}.resolve()
void invokeHandler
void runPromise
void silentInvoke
`,
  "packages/electron-ipc/preload-electron.ts": `import { contextBridge, ipcRenderer } from "electron"
import type { IpcRendererEvent } from "electron"
export const electronPreloadDeps = {
  send: (payload: unknown) => ipcRenderer.send("channel", payload),
  invoke: (payload: unknown): ${promiseLikeType}<unknown> => ipcRenderer.invoke("channel", payload),
  on: (listener: () => void) => { ipcRenderer.on("channel", listener); return () => ipcRenderer.removeListener("channel", listener) },
  exposeInMainWorld: (api: unknown) => contextBridge.exposeInMainWorld("expand", api),
  postToMainWorld: (message: unknown) => ${windowPostMessage}(message, "*"),
  onContextDisposed: (dispose: () => void) => { ${windowAddEventListener}("unload", dispose); return () => ${windowRemoveEventListener}("unload", dispose) }
}
const origin = ${windowLocation}.origin
const release = () => ${windowRemoveEventListener}("unload", release)
void origin
void release
void (null as IpcRendererEvent | null)
`,
  "packages/electron-ipc/preload.ts": `export interface PreloadIpcDeps { invoke: () => ${promiseType}<unknown> }
export const exposeBridge = (invoke: () => ${promiseType}<unknown>) => invoke
`,
  "packages/electron-ipc/renderer.ts": `const makeNonce = () => ${cryptoRandomUUID}()
void makeNonce
`,
  "packages/client-ts/adapters/node-process-control.ts": processControlBoundarySource,
  "packages/client-ts/adapters/node.ts": `import { WebSocket as WS } from "ws"
const wsConstructor = () => new WS("ws://localhost")
void wsConstructor
`,
  "packages/client-ts/scripts/prepare-publish.ts": bracketRunnerBoundarySource,
  "packages/client-ts/test/fixtures/spawn-lock-contender.ts": runnerBoundarySource,
  "packages/client-ts/test/prepare-publish.test.ts": dynamicImportBoundarySource,
  "packages/contracts/scripts/prepare-publish.ts": bracketRunnerBoundarySource,
  "packages/contracts/test/prepare-publish.test.ts": dynamicImportBoundarySource,
  "docs/architecture/scripts/build.ts": bracketRunnerBoundarySource,
  "docs/architecture/scripts/build.test.ts": dynamicImportBoundarySource,
  "scripts/build.test.ts": dynamicImportBoundarySource,
  "scripts/build.ts": `import { NodeRuntime } from "@effect/platform-node"
const buildTool = { try: (): ${promiseLikeType}<void> => ({ then: () => undefined } as never) }
declare const program: never
${nodeRuntimeRunMain}(program)
void buildTool
`,
  "scripts/binary-smoke.ts": bracketRunnerBoundarySource,
  "scripts/desktop-command.test.ts": dynamicImportBoundarySource,
  "scripts/desktop-command.ts": bracketRunnerBoundarySource,
  "scripts/effect-audit.ts": runnerBoundarySource,
  "scripts/fold-version.ts": runnerBoundarySource,
  "scripts/package-certification.ts": runnerBoundarySource,
  "scripts/sync-agents.test.ts": `import { Effect } from "effect"
Effect.promise(() => import("effect"))
`,
  "scripts/sync-agents.ts": runnerBoundarySource,
  "test/architecture/client-ts-barrel.test.ts": `import { createRequire } from "node:module"
void createRequire
`,
  "test/architecture/depcruise-exclude.test.ts": `import { createRequire } from "node:module"
void createRequire
`,
  "test/architecture/fold-version-lockstep.test.ts": dynamicImportBoundarySource
}

const allBoundaryFiles = Object.keys(boundarySourceCatalog)

describe("Effect platform host-boundary classification", () => {
  it.effect("accepts an exact analyzer-proven platform host-boundary classification", () => {
    const line = `  const cwd = yield* Effect.try({ try: () => ${hostProcessCwd}(), catch: String })\n`
    const reviewed = candidate({
      file: "apps/cli/cli/node-app-context.ts",
      declaration: "member:cwd.try",
      construct: platformProcessCwd,
      classification: "host-boundary",
      rationale: "Node AppContext host acquisition",
      line: 5,
      excerpt: line.trim()
    })
    return fixture({
            inventory: [reviewed],
      grepJson: grepJson(grepMatch(
        "apps/cli/cli/node-app-context.ts",
        line,
        5,
        hostProcessCwd,
        undefined,
        byteOffsetAtLine(appContextBoundarySource, 5)
      ))
    }, ({ root }) => runAudit(root).pipe(Effect.asVoid))
  })

  it.effect("rejects a reviewed host boundary without analyzer and permanent-registry proof", () => {
    const source = `export const sample = ${asyncKeyword} () => 1\n`
    const reviewed = candidate({
      file: "src/sample.ts",
      declaration: "variable:sample",
      construct: nativeAsync,
      classification: "host-boundary",
      rationale: "Unproven host boundary",
      excerpt: source.trim()
    })
    return fixture({
            inventory: [reviewed],
      source,
      grepJson: grepJson(grepMatch("src/sample.ts", source, 1, asyncKeyword))
    }, ({ root }) =>
      Effect.gen(function*() {
        const error = yield* runAudit(root).pipe(Effect.flip)
        expect(error).toMatchObject({
          reason: "invalid-output",
          detail: expect.stringContaining("lacks an exact permanent boundary")
        })
      }))
  })
})

describe("registered Effect language diagnostic command", () => {
  it.effect("validates every permanent host boundary in each isolated audit fixture", () => {
    const registeredFiles = new Set(effectHostBoundaries.map(({ file }) => file))
    const syntheticFiles = new Set(Object.keys(boundarySourceCatalog))
    const missing = [...registeredFiles].filter((file) => !syntheticFiles.has(file))
    const unregisteredFiles = [...syntheticFiles].filter((file) => !registeredFiles.has(file))

    expect({ missing, unregistered: unregisteredFiles }).toEqual({ missing: [], unregistered: [] })

    const start = serverHttpBoundarySource.indexOf(`"${nodeHttp}"`)
    const registered = `{"diagnostics":[{"file":"apps/server/http.ts","start":${start},"length":${nodeHttp.length + 2},"line":2,"column":${start + 1},"severity":"error","name":"nodeBuiltinImport","message":"use Effect HTTP"}]}`
    const unregisteredSource = `import { createServer } from "${nodeHttp}"\n`
    const unregisteredStart = unregisteredSource.indexOf(`"${nodeHttp}"`)
    const unregistered = `{"diagnostics":[{"file":"src/sample.ts","start":${unregisteredStart},"length":${nodeHttp.length + 2},"line":1,"column":${unregisteredStart + 1},"severity":"error","name":"nodeBuiltinImport","message":"use Effect HTTP"}]}`

    return fixture({ languageService: registered }, ({ root }) =>
      runAudit(root).pipe(Effect.asVoid)
    ).pipe(Effect.andThen(
      fixture({
                source: unregisteredSource,
        languageService: unregistered
      }, ({ root }) =>
        Effect.gen(function*() {
          const error = yield* runAudit(root).pipe(Effect.flip)
          expect(error).toMatchObject({
            reason: "blocking-findings",
            findings: [{
              engine: "effect-language-service",
              file: "src/sample.ts",
              rule: "nodeBuiltinImport"
            }]
          })
        })
      )
    ))
  })
})

import { clearParserCaches } from "./effect-audit-test-support.mjs"
import { afterEach } from "vitest"

afterEach(clearParserCaches)
