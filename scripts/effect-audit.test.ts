import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, Exit, FileSystem, Layer, Path, Schema } from "effect"
import { describe, expect } from "vitest"
import {
  AuditBaselineJson,
  AuditFinding,
  EffectAuditError,
  canUpdateBaseline,
  compareAudit,
  findingKey
} from "./effect-audit-model"
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
  readonly baseline?: ReadonlyArray<AuditFinding> | string | undefined
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
    const tracked = [...boundaryFiles, sample]

    for (const file of tracked) {
      yield* fs.makeDirectory(path.dirname(path.join(root, file)), { recursive: true })
      yield* fs.writeFileString(path.join(root, file), file === sample ? source : boundarySource)
    }
    yield* fs.writeFileString(path.join(root, "tsconfig.effect-audit.json"), JSON.stringify({
      compilerOptions: { strict: true },
      include: ["**/*.ts"]
    }))

    if (options.baseline !== undefined) {
      const encoded = typeof options.baseline === "string"
        ? options.baseline
        : Schema.encodeSync(AuditBaselineJson)([...options.baseline])
      yield* fs.writeFileString(path.join(root, "effect-audit-baseline.json"), encoded)
    }

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
      eslint: { exitCode: 0, stdout: options.eslint ?? JSON.stringify(eslintFiles), stderr: "" },
      "typescript-files": { exitCode: 0, stdout: `${typeScriptFiles}\n`, stderr: "" },
      "tracked-files": { exitCode: 0, stdout: `${tracked.join("\0")}\0`, stderr: "" },
      "tracked-modes": {
        exitCode: 0,
        stdout: `${tracked.map((file) => `100644 ${"0".repeat(40)} 0\t${file}`).join("\0")}\0`,
        stderr: ""
      },
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

describe("Effect audit model", () => {
  it("keeps identity stable across line and excerpt changes", () => {
    const original = finding()
    const moved = finding({ line: 400, excerpt: "async    () => value" })

    expect(findingKey(original)).toBe(findingKey(moved))
    expect(compareAudit([original], [moved])).toEqual({ added: [], removed: [] })
  })

  it("disambiguates repeated constructs by occurrence", () => {
    expect(findingKey(finding({ occurrence: 0 }))).not.toBe(findingKey(finding({ occurrence: 1 })))
  })

  it("deduplicates semantically identical findings only within one engine", () => {
    const language = finding()
    const eslint = finding({ engine: "eslint" })

    expect(compareAudit([], [language, finding({ line: 99 }), eslint]).added.map(findingKey)).toEqual([
      findingKey(language),
      findingKey(eslint)
    ])
  })

  it("allows identical and strict-subset updates but rejects additions", () => {
    const first = finding()
    const second = finding({ occurrence: 1 })

    expect(canUpdateBaseline([first, second], [first, second])).toBe(true)
    expect(canUpdateBaseline([first, second], [first])).toBe(true)
    expect(canUpdateBaseline([first], [first, second])).toBe(false)
  })
})

describe("Effect audit command", () => {
  it.effect("runs the exact repository commands through the injectable service", () =>
    fixture({ baseline: [] }, ({ root, requests }) =>
      Effect.gen(function*() {
        const result = yield* runAudit({ root, mode: "check" })

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
          },
          {
            name: "tracked-modes",
            command: "git",
            args: ["ls-files", "-s", "-z"],
            cwd: root,
            acceptedExitCodes: [0]
          }
        ])
      })))

  it.effect("rejects a missing baseline in check and update modes", () =>
    fixture({}, ({ root }) =>
      Effect.gen(function*() {
        const check = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
        const update = yield* runAudit({ root, mode: "update" }).pipe(Effect.flip)

        expect(check.reason).toBe("baseline-missing")
        expect(update.reason).toBe("baseline-missing")
      })))

  it.effect("rejects advisory and duplicate records in the blocking baseline", () =>
    fixture({ baseline: [finding({ severity: "message" })] }, ({ root }) =>
      Effect.gen(function*() {
        const advisory = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
        expect(advisory.reason).toBe("invalid-output")
      })).pipe(Effect.andThen(
        fixture({ baseline: [finding(), finding({ line: 88 })] }, ({ root }) =>
          Effect.gen(function*() {
            const duplicate = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
            expect(duplicate.reason).toBe("invalid-output")
          }))
      )))

  it.effect("rejects malformed and empty command JSON", () =>
    fixture({ baseline: [], languageService: "{" }, ({ root }) =>
      Effect.gen(function*() {
        const malformed = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
        expect(malformed.reason).toBe("invalid-output")
      })).pipe(Effect.andThen(
        fixture({ baseline: [], eslint: "" }, ({ root }) =>
          Effect.gen(function*() {
            const empty = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
            expect(empty.reason).toBe("invalid-output")
          }))
      )))

  it.effect("rejects signals, platform failures, and unaccepted exit codes", () =>
    fixture({ baseline: [], fail: "language-service" }, ({ root }) =>
      Effect.gen(function*() {
        const signal = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
        expect(signal).toMatchObject({ reason: "command-failed", detail: expect.stringContaining("SIGTERM") })
      })).pipe(Effect.andThen(
        fixture({ baseline: [], result: { eslint: { exitCode: 2 } } }, ({ root }) =>
          Effect.gen(function*() {
            const invalid = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
            expect(invalid).toMatchObject({ reason: "command-failed", detail: expect.stringContaining("eslint") })
          }))
      )))

  it.effect("accepts diagnostic exit one only when stdout decodes", () =>
    fixture({ baseline: [], result: { "language-service": { exitCode: 1 } } }, ({ root }) =>
      Effect.gen(function*() {
        yield* runAudit({ root, mode: "check" })
      })).pipe(Effect.andThen(
        fixture({ baseline: [], languageService: "not-json", result: { "language-service": { exitCode: 1 } } }, ({ root }) =>
          Effect.gen(function*() {
            const error = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
            expect(error.reason).toBe("invalid-output")
          }))
      )))

  it.effect("fails when either semantic engine omits an indexed source", () =>
    fixture({ baseline: [], omitTypeScript: true }, ({ root }) =>
      Effect.gen(function*() {
        const typescript = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
        expect(typescript).toMatchObject({ reason: "coverage-gap", detail: expect.stringContaining("src/sample.ts") })
      })).pipe(Effect.andThen(
        fixture({ baseline: [], omitEslint: true }, ({ root }) =>
          Effect.gen(function*() {
            const eslint = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
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
    return fixture({ baseline: [], source, languageService: diagnostic }, ({ root }) =>
      Effect.gen(function*() {
        const error = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
        expect(error.reason).toBe("new-findings")
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

  it.effect("requires shrink-only update before accepting stale debt", () =>
    fixture({ baseline: [finding()] }, ({ root }) =>
      Effect.gen(function*() {
        const stale = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
        expect(stale.reason).toBe("stale-baseline")

        const updated = yield* runAudit({ root, mode: "update" })
        const fs = yield* FileSystem.FileSystem
        expect(updated.removed).toHaveLength(1)
        expect(Schema.decodeUnknownSync(AuditBaselineJson)(yield* fs.readFileString(`${root}/effect-audit-baseline.json`))).toEqual([])

        yield* runAudit({ root, mode: "check" })
      })))

  it.effect("refuses to update a baseline when findings were added", () => {
    const source = "export const sample = async () => 1\n"
    return fixture({
      baseline: [],
      source,
      languageService: JSON.stringify({ diagnostics: [{
        file: "src/sample.ts",
        start: source.indexOf("async"),
        line: 1,
        severity: "error",
        name: "asyncFunction",
        message: "native async"
      }] })
    }, ({ root }) =>
      Effect.gen(function*() {
        const error = yield* runAudit({ root, mode: "update" }).pipe(Effect.flip)
        expect(error.reason).toBe("baseline-growth")
      }))
  })

  it.effect("preserves an ESLint identity after a CRLF line terminator", () => {
    const source = "export const a = 1\r\nexport async function load() {}"
    return fixture({
      baseline: [],
      source,
      eslint: JSON.stringify([
        ...boundaryFiles.map((filePath) => ({ filePath, messages: [] })),
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
        const error = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)

        expect(error).toMatchObject({
          reason: "new-findings",
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
      baseline: [],
      eslint: JSON.stringify([
        ...boundaryFiles.map((filePath) => ({ filePath, messages: [] })),
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
        const error = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
        expect(error).toMatchObject({ _tag: "EffectAuditError", reason: "invalid-output" })
      }))))

  it.effect("accepts the valid fatal ESLint message shape", () =>
    fixture({
      baseline: [],
      eslint: JSON.stringify([
        ...boundaryFiles.map((filePath) => ({ filePath, messages: [] })),
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
        const error = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
        expect(error).toMatchObject({
          reason: "new-findings",
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
  shrinkGrepInventory
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
  start = lines.indexOf(match)
) => ({
  type: "match",
  data: {
    path: { text: file },
    lines: { text: lines },
    line_number: lineNumber,
    absolute_offset: 0,
    submatches: [{ match: { text: match }, start, end: start + new TextEncoder().encode(match).length }]
  }
})

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

  it("permits only strict-subset migration-debt updates and preserves non-debt records byte-for-byte", () => {
    const debt = candidate()
    const reviewed = candidate({
      occurrence: 1,
      classification: "false-positive",
      rationale: "Effect.catch is Effect composition",
      line: 21,
      excerpt: "Effect.catch(program, recover)"
    })
    const currentReviewed = candidate({
      occurrence: 1,
      classification: "false-positive",
      rationale: "Effect.catch is Effect composition",
      line: 99,
      excerpt: "Effect.catch(program,recover)"
    })

    expect(shrinkGrepInventory([debt, reviewed], [currentReviewed])).toEqual([reviewed])
    expect(shrinkGrepInventory([debt, reviewed], [debt, currentReviewed])).toBeUndefined()
    expect(shrinkGrepInventory([debt, reviewed], [debt])).toBeUndefined()
    expect(shrinkGrepInventory([debt], [debt, candidate({ occurrence: 2 })])).toBeUndefined()
    expect(shrinkGrepInventory([reviewed], [candidate({
      occurrence: 1,
      classification: "host-required-type",
      rationale: "changed"
    })])).toBeUndefined()
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
  it.effect("rejects a missing grep inventory in check and update modes", () =>
    fixture({ baseline: [], omitInventory: true }, ({ root }) =>
      Effect.gen(function*() {
        const check = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
        const update = yield* runAudit({ root, mode: "update" }).pipe(Effect.flip)

        expect(check).toMatchObject({ reason: "baseline-missing", detail: expect.stringContaining("effect-grep-inventory.json") })
        expect(update).toMatchObject({ reason: "baseline-missing", detail: expect.stringContaining("effect-grep-inventory.json") })
      })))

  it.effect("uses the approved grep expression and globs with JSON output and an explicit machine root", () =>
    fixture({ baseline: [], recordGrepRequest: true }, ({ root, requests }) =>
      Effect.gen(function*() {
        yield* runAudit({ root, mode: "check" })
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
    fixture({ baseline: [], grepJson: "{" }, ({ root }) =>
      Effect.gen(function*() {
        const malformed = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
        expect(malformed.reason).toBe("invalid-output")
      })).pipe(Effect.andThen(
        fixture({ baseline: [], result: { "grep-json": { exitCode: 1 } } }, ({ root }) =>
          runAudit({ root, mode: "check" }).pipe(Effect.asVoid)
        )
      )))

  it.effect("filters grep output to uniquely tracked and indexed first-party source paths", () =>
    fixture({
      baseline: [],
      grepJson: grepJson(grepMatch("src/untracked.ts", "export const load = async () => 1\n", 1, "async"))
    }, ({ root }) =>
      Effect.gen(function*() {
        const result = yield* runAudit({ root, mode: "check" })
        expect(result.grepCandidates).toEqual([])
      })))

  it.effect("fails on a new unclassified grep submatch", () => {
    const source = "export const sample = async () => 1\n"
    return fixture({
      baseline: [],
      source,
      grepJson: grepJson(grepMatch("src/sample.ts", source, 1, "async"))
    }, ({ root }) =>
      Effect.gen(function*() {
        const error = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
        expect(error).toMatchObject({ reason: "new-findings", detail: expect.stringContaining("grep inventory") })
      }))
  })

  it.effect("keeps deleted grep debt stale until a shrink-only update", () => {
    const stale = candidate({ file: "src/sample.ts", declaration: "variable:sample" })
    return fixture({ baseline: [], inventory: [stale] }, ({ root }) =>
      Effect.gen(function*() {
        const check = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
        expect(check).toMatchObject({ reason: "stale-baseline", detail: expect.stringContaining("grep inventory") })

        const updated = yield* runAudit({ root, mode: "update" })
        const fs = yield* FileSystem.FileSystem
        const decoded = yield* Schema.decodeUnknownEffect(GrepInventoryJson)(
          yield* fs.readFileString(`${root}/effect-grep-inventory.json`)
        )
        expect(updated.grepRemoved).toEqual([stale])
        expect(decoded).toEqual([])
        yield* runAudit({ root, mode: "check" })
      }))
  })

  it.effect("never removes or rewrites a reviewed non-debt record during automatic update", () => {
    const source = "import { Effect } from \"effect\"\nexport const sample = Effect.catch(Effect.succeed(1), () => Effect.succeed(2))\n"
    const lines = "export const sample = Effect.catch(Effect.succeed(1), () => Effect.succeed(2))\n"
    const reviewed = candidate({
      file: "src/sample.ts",
      declaration: "variable:sample",
      construct: "lexical:.catch(",
      classification: "false-positive",
      rationale: "Effect.catch is Effect composition",
      line: 20,
      excerpt: "preserve this reviewed display text"
    })
    return fixture({
      baseline: [],
      inventory: [reviewed],
      source,
      grepJson: grepJson(grepMatch("src/sample.ts", lines, 2, ".catch("))
    }, ({ root }) =>
      Effect.gen(function*() {
        yield* runAudit({ root, mode: "update" })
        const fs = yield* FileSystem.FileSystem
        const decoded = yield* Schema.decodeUnknownEffect(GrepInventoryJson)(
          yield* fs.readFileString(`${root}/effect-grep-inventory.json`)
        )
        expect(decoded).toEqual([reviewed])
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
      baseline: [],
      inventory: [reviewed],
      grepJson: grepJson(grepMatch("apps/cli/cli/main.ts", "NodeRuntime.runMain(program)\n", 3, "NodeRuntime.runMain"))
    }, ({ root }) => runAudit({ root, mode: "check" }).pipe(Effect.asVoid))
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
      baseline: [],
      inventory: [hostType],
      source: hostTypeSource,
      grepJson: grepJson(grepMatch("src/sample.ts", hostTypeSource, 1, "Promise<"))
    }, ({ root }) => runAudit({ root, mode: "check" }).pipe(Effect.asVoid)).pipe(
      Effect.andThen(fixture({
        baseline: [],
        inventory: [auditFixture],
        sampleFile: "test/sample.test.ts",
        source: fixtureSource,
        grepJson: grepJson(grepMatch("test/sample.test.ts", fixtureSource, 1, "async"))
      }, ({ root }) => runAudit({ root, mode: "check" }).pipe(Effect.asVoid))),
      Effect.andThen(fixture({
        baseline: [],
        inventory: [falsePositive],
        source: falsePositiveSource,
        grepJson: grepJson(grepMatch("src/sample.ts", falsePositiveLine, 2, ".catch("))
      }, ({ root }) => runAudit({ root, mode: "check" }).pipe(Effect.asVoid)))
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

    return fixture({ baseline: [], inventory: [falsePositive], source, grepJson: match }, ({ root }) =>
      Effect.gen(function*() {
        const error = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
        expect(error).toMatchObject({ reason: "invalid-output", detail: expect.stringContaining("false-positive") })
      })).pipe(Effect.andThen(
        fixture({ baseline: [], inventory: [emptyRationale], source, grepJson: match }, ({ root }) =>
          Effect.gen(function*() {
            const error = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
            expect(error).toMatchObject({ reason: "invalid-output", detail: expect.stringContaining("rationale") })
          }))
      ))
  })
})
