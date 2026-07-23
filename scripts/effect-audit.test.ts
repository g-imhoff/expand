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
    }) => Effect.Effect<A, unknown, AuditCommandRunner | FileSystem.FileSystem | (AuditFixturePath & {})>
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
    yield* fs.writeFileString(path.join(root, "tsconfig.effect-audit.json"), JSON.stringify({
      compilerOptions: { strict: true },
      include: ["**/*.ts", "**/*.tsx"]
    }))
    for (const file of allBoundaryFiles) {
      yield* fs.writeFileString(path.join(root, file), boundarySourceCatalog[file]!)
    }
    yield* fs.makeDirectory(path.join(root, "node_modules/electron"), { recursive: true })
    yield* fs.writeFileString(path.join(root, "node_modules/electron/package.json"), '{"types":"index.d.ts"}')
    yield* fs.writeFileString(path.join(root, "node_modules/electron/index.d.ts"), electronTypeSource)

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

    const launcherFiles = options.launcherFiles ?? []
    const launcherPaths = launcherFiles.map(({ file }) => file)
    const allTracked = [...tracked, ...launcherPaths]
    const modeByFile = new Map(launcherFiles.map(({ file, mode }) => [file, mode]))
    defaults["tracked-files"] = { exitCode: 0, stdout: `${allTracked.join("\0")}\0`, stderr: "" }
    defaults["tracked-modes"] = {
      exitCode: 0,
      stdout: `${allTracked.map((file) => `${modeByFile.get(file) ?? "100644"} ${"0".repeat(40)} 0\t${file}`).join("\0")}\0`,
      stderr: ""
    }
    for (const launcher of launcherFiles) {
      if (launcher.write === false) continue
      yield* fs.makeDirectory(path.dirname(path.join(root, launcher.file)), { recursive: true })
      yield* fs.writeFileString(path.join(root, launcher.file), launcher.source)
    }
    yield* fs.writeFileString(
      path.join(root, "package.json"),
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Struct({
        scripts: Schema.Record(Schema.String, Schema.String)
      })))({ scripts: {
        "agents:check": "agents-check",
        "effect:audit": "effect-audit",
        lint: "lint",
        "typecheck:all": "typecheck-all"
      } })
    )
    if (!options.omitLauncherInventory) {
      const inventory = options.launcherInventory ?? []
      const encoded = typeof inventory === "string"
        ? inventory
        : yield* Schema.encodeEffect(LauncherInventoryJson)([...inventory])
      yield* fs.writeFileString(path.join(root, "effect-launchers.json"), encoded)
    }

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
        const error = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
        expect(error).toMatchObject({ _tag: "EffectAuditError", reason: "invalid-output" })
      }))))

  it.effect("accepts the valid fatal ESLint message shape", () =>
    fixture({
      baseline: [],
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
  ExecutableBoundary,
  GrepCandidate,
  GrepInventoryJson,
  LauncherInventoryJson,
  compareLauncherInventory,
  compareGrepInventory,
  executableBoundaryKey,
  grepCandidateKey,
  grepInventoryValidationError,
  launcherInventoryValidationError,
  shrinkLauncherInventory,
  shrinkGrepInventory
} from "./effect-inventory-model"
import { EFFECT_GREP_ARGS, parseTrackedModes, utf8ByteOffsetToCodeUnit } from "./effect-audit"
import { Crypto, Encoding } from "effect"

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
      grepJson: grepJson(grepMatch("src/sample.ts", lines, 2, ".catch(", undefined, byteOffsetAtLine(source, 2)))
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
      grepJson: grepJson(grepMatch(
        "apps/cli/cli/main.ts",
        "NodeRuntime.runMain(program)\n",
        3,
        "NodeRuntime.runMain",
        undefined,
        byteOffsetAtLine(boundarySource, 3)
      ))
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
        grepJson: grepJson(grepMatch(
          "src/sample.ts",
          falsePositiveLine,
          2,
          ".catch(",
          undefined,
          byteOffsetAtLine(falsePositiveSource, 2)
        ))
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
      baseline: [],
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
        const check = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
        const update = yield* runAudit({ root, mode: "update" }).pipe(Effect.flip)

        expect(check).toMatchObject({
          reason: "new-findings",
          detail: expect.stringContaining("implicit reclassifications")
        })
        expect(update).toMatchObject({
          reason: "baseline-growth",
          detail: expect.stringContaining("implicit reclassifications")
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
    return fixture({ baseline: [], source, grepJson: grepJson(inconsistent) }, ({ root }) =>
      Effect.gen(function*() {
        const error = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
        expect(error.reason).toBe("invalid-output")
      })).pipe(Effect.andThen(
        fixture({ baseline: [], source, grepJson: grepJson(outOfRange) }, ({ root }) =>
          Effect.gen(function*() {
            const error = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
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
    return fixture({ baseline: [], source, grepJson: grepJson(wrongOffset) }, ({ root }) =>
      Effect.gen(function*() {
        const error = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
        expect(error.reason).toBe("invalid-output")
      })).pipe(Effect.andThen(
        fixture({ baseline: [], source, grepJson: grepJson(wrongText) }, ({ root }) =>
          Effect.gen(function*() {
            const error = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
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
    return fixture({ baseline: [], source, grepJson: grepJson(outOfRange) }, ({ root }) =>
      Effect.gen(function*() {
        const error = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
        expect(error.reason).toBe("invalid-output")
      })).pipe(Effect.andThen(
        fixture({ baseline: [], source, grepJson: grepJson(splitCharacter) }, ({ root }) =>
          Effect.gen(function*() {
            const error = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
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
    return fixture({ baseline: [], source, grepJson: grepJson(event, event) }, ({ root }) =>
      Effect.gen(function*() {
        const error = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
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
      baseline: [],
      inventory: [stored],
      source,
      grepJson: grepJson(grepMatch("src/sample.ts", source, 1, keyword))
    }, ({ root }) =>
      Effect.gen(function*() {
        const result = yield* runAudit({ root, mode: "check" })
        expect(result.grepCandidates).toEqual([stored])
      }))
  })

  it.effect("removes stale debt without changing reviewed record bytes", () =>
    Effect.gen(function*() {
      const method = [".ca", "tch("].join("")
      const source = `import { Effect } from "effect"\nexport const sample = Effect${method}Effect.succeed(1), () => Effect.succeed(2))\n`
      const lines = source.slice(source.indexOf("\n") + 1)
      const stale = candidate({
        file: "a/stale.ts",
        declaration: "module:<module>",
        construct: "lexical:stale",
        occurrence: 0,
        classification: "migration-debt",
        rationale: ""
      })
      const reviewed = candidate({
        file: "src/sample.ts",
        declaration: "variable:sample",
        construct: `lexical:${method}`,
        occurrence: 0,
        classification: "false-positive",
        rationale: "Effect composition method",
        line: 22,
        excerpt: "preserve exact reviewed bytes"
      })
      const before = yield* Schema.encodeEffect(GrepInventoryJson)([stale, reviewed])
      const reviewedOnly = yield* Schema.encodeEffect(GrepInventoryJson)([reviewed])
      yield* fixture({
        baseline: [],
        inventory: before,
        source,
        grepJson: grepJson(grepMatch(
          "src/sample.ts",
          lines,
          2,
          method,
          undefined,
          byteOffsetAtLine(source, 2)
        ))
      }, ({ root }) =>
        Effect.gen(function*() {
          const result = yield* runAudit({ root, mode: "update" })
          const fs = yield* FileSystem.FileSystem
          const after = yield* fs.readFileString(`${root}/effect-grep-inventory.json`)

          expect(result.grepRemoved).toEqual([stale])
          expect(after).toBe(reviewedOnly)
          expect(before).toContain(reviewedOnly.slice(1, -1))
        }))
    }))

  it.effect("requires canonical inventory bytes before update", () =>
    fixture({ baseline: [], inventory: "[ ]" }, ({ root }) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const baselineBefore = yield* fs.readFileString(`${root}/effect-audit-baseline.json`)
        const inventoryBefore = yield* fs.readFileString(`${root}/effect-grep-inventory.json`)
        const error = yield* runAudit({ root, mode: "update" }).pipe(Effect.flip)
        const baselineAfter = yield* fs.readFileString(`${root}/effect-audit-baseline.json`)
        const inventoryAfter = yield* fs.readFileString(`${root}/effect-grep-inventory.json`)

        expect(error).toMatchObject({ reason: "invalid-output", detail: expect.stringContaining("canonical") })
        expect(baselineAfter).toBe(baselineBefore)
        expect(inventoryAfter).toBe(inventoryBefore)
      })))

  it.effect("validates both ledgers before applying a shrink update", () => {
    const keyword = ["as", "ync"].join("")
    const source = `export const sample = ${keyword} () => 1\n`
    return fixture({
      baseline: [finding()],
      inventory: [],
      source,
      grepJson: grepJson(grepMatch("src/sample.ts", source, 1, keyword))
    }, ({ root }) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const baselineBefore = yield* fs.readFileString(`${root}/effect-audit-baseline.json`)
        const inventoryBefore = yield* fs.readFileString(`${root}/effect-grep-inventory.json`)
        const error = yield* runAudit({ root, mode: "update" }).pipe(Effect.flip)
        const baselineAfter = yield* fs.readFileString(`${root}/effect-audit-baseline.json`)
        const inventoryAfter = yield* fs.readFileString(`${root}/effect-grep-inventory.json`)

        expect(error.reason).toBe("baseline-growth")
        expect(baselineAfter).toBe(baselineBefore)
        expect(inventoryAfter).toBe(inventoryBefore)
      }))
  })
})

describe("Effect grep ripgrep line model", () => {
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
      baseline: [],
      inventory: [stored],
      source,
      grepJson: grepJson(grepMatch("src/sample.ts", source, 1, keyword, undefined, 0))
    }, ({ root }) =>
      Effect.gen(function*() {
        const result = yield* runAudit({ root, mode: "check" })

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
      baseline: [],
      inventory: [stored],
      source,
      grepJson: grepJson(grepMatch("src/sample.ts", lines, 2, keyword, undefined, absoluteOffset))
    }, ({ root }) =>
      Effect.gen(function*() {
        const result = yield* runAudit({ root, mode: "check" })

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
      baseline: [],
      inventory: [stored],
      source,
      grepJson: grepJson(grepMatch("src/sample.ts", source, 1, keyword, undefined, 0))
    }, ({ root }) =>
      Effect.gen(function*() {
        const result = yield* runAudit({ root, mode: "check" })

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
      baseline: [],
      inventory: [stored],
      source,
      grepJson: grepJson(grepMatch("src/sample.ts", source, 1, keyword, undefined, 0))
    }, ({ root }) =>
      Effect.gen(function*() {
        const result = yield* runAudit({ root, mode: "check" })

        expect(result.grepCandidates).toEqual([expected])
      }))
  })
})

interface FixtureOptions {
  readonly launcherInventory?: ReadonlyArray<ExecutableBoundary> | string | undefined
  readonly omitLauncherInventory?: boolean | undefined
  readonly launcherFiles?: ReadonlyArray<{
    readonly file: string
    readonly mode: "100644" | "100755" | "120000" | "160000"
    readonly source: string
    readonly write?: boolean | undefined
  }> | undefined
}

type AuditFixturePath = Crypto.Crypto | Path.Path

const launcherBoundary = (overrides: Partial<ExecutableBoundary> = {}) => new ExecutableBoundary({
  file: "scripts/example.sh",
  mode: "100644",
  sourceSha256: "0".repeat(64),
  classification: "migration-debt",
  host: "Legacy shell launcher",
  ...overrides
})

const launcherForSource = Effect.fn("EffectAuditTest.launcherForSource")(
  (options: {
    readonly file: string
    readonly mode: "100644" | "100755"
    readonly source: string
    readonly classification?: "host-launcher" | "host-fixture" | "migration-debt"
    readonly host?: string
  }) => Effect.gen(function*() {
    const crypto = yield* Crypto.Crypto
    const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(options.source))
    return new ExecutableBoundary({
      file: options.file,
      mode: options.mode,
      sourceSha256: Encoding.encodeHex(digest),
      classification: options.classification ?? "migration-debt",
      host: options.host ?? "Synthetic launcher"
    })
  }).pipe(Effect.provide(NodeServices.layer))
)

describe("Effect launcher inventory model", () => {
  it("accepts only lower-case 64-character SHA-256 fingerprints", () => {
    expect(Schema.decodeUnknownSync(ExecutableBoundary)(launcherBoundary())).toEqual(launcherBoundary())
    for (const sourceSha256 of [
      "A".repeat(64),
      `${"0".repeat(63)}g`,
      "0".repeat(63),
      "0".repeat(65)
    ]) {
      expect(() => Schema.decodeUnknownSync(ExecutableBoundary)({
        ...launcherBoundary(),
        sourceSha256
      })).toThrow()
    }
    expect(() => Schema.decodeUnknownSync(ExecutableBoundary)({
      ...launcherBoundary(),
      classification: "approved"
    })).toThrow()
  })

  it("keys launcher records only by repository-relative path", () => {
    const original = launcherBoundary()
    const changed = launcherBoundary({
      mode: "100755",
      sourceSha256: "1".repeat(64),
      classification: "host-launcher",
      host: "Reviewed entry hook"
    })

    expect(executableBoundaryKey(original)).toBe("scripts/example.sh")
    expect(executableBoundaryKey(original)).toBe(executableBoundaryKey(changed))
  })

  it("rejects duplicate, unsorted, malformed, unsupported, and blank-host records", () => {
    const first = launcherBoundary({ file: "a/first.sh" })
    const second = launcherBoundary({ file: "b/second.sh" })

    expect(launcherInventoryValidationError([first, first])).toContain("duplicate")
    expect(launcherInventoryValidationError([second, first])).toContain("sorted")
    for (const file of ["", "/absolute.sh", "../escape.sh", "a/../escape.sh", "a//b.sh", "a/./b.sh", "a\\b.sh", "a/*.sh", "a/"]) {
      expect(launcherInventoryValidationError([launcherBoundary({ file })])).toContain("path")
    }
    expect(launcherInventoryValidationError([launcherBoundary({ mode: "120000" })])).toContain("mode")
    expect(launcherInventoryValidationError([launcherBoundary({ file: "src/not-selected.ts" })])).toContain("selected")
    expect(launcherInventoryValidationError([launcherBoundary({ host: "" })])).toContain("host")
    expect(launcherInventoryValidationError([launcherBoundary({ host: " padded " })])).toContain("host")
    expect(launcherInventoryValidationError([first, second])).toBeUndefined()
  })

  it("compares every mutable field independently while preserving path identity", () => {
    const expected = [
      launcherBoundary({ file: "a/removed.sh" }),
      launcherBoundary({ file: "b/mode.sh" }),
      launcherBoundary({ file: "c/source.sh" }),
      launcherBoundary({ file: "d/classification.sh" }),
      launcherBoundary({ file: "e/host.sh" })
    ]
    const modeChanged = launcherBoundary({ file: "b/mode.sh", mode: "100755" })
    const sourceChanged = launcherBoundary({ file: "c/source.sh", sourceSha256: "1".repeat(64) })
    const reclassified = launcherBoundary({
      file: "d/classification.sh",
      classification: "host-fixture"
    })
    const hostChanged = launcherBoundary({ file: "e/host.sh", host: "Changed host" })
    const added = launcherBoundary({ file: "f/added.sh" })

    expect(compareLauncherInventory(expected, [modeChanged, sourceChanged, reclassified, hostChanged, added])).toEqual({
      added: [added],
      removed: [expected[0]],
      modeChanged: [modeChanged],
      sourceChanged: [sourceChanged],
      reclassified: [reclassified],
      hostChanged: [hostChanged]
    })
  })

  it.effect("permits only strict-subset debt removal and returns canonical expected survivors", () =>
    Effect.gen(function*() {
      const stale = launcherBoundary({ file: "a/stale.sh" })
      const reviewed = launcherBoundary({
        file: "b/reviewed.sh",
        mode: "100755",
        sourceSha256: "2".repeat(64),
        classification: "host-launcher",
        host: "Reviewed host"
      })
      const fixtureRecord = launcherBoundary({
        file: "c/fixture.sh",
        classification: "host-fixture",
        host: "Reviewed fixture"
      })
      const survivors = shrinkLauncherInventory([stale, reviewed], [reviewed])
      const before = yield* Schema.encodeEffect(LauncherInventoryJson)([stale, reviewed])
      const after = yield* Schema.encodeEffect(LauncherInventoryJson)(survivors ?? [])

      expect(survivors).toEqual([reviewed])
      expect(survivors?.[0]).toBe(reviewed)
      expect(before).toContain(after.slice(1, -1))
      expect(shrinkLauncherInventory([stale, reviewed], [stale, reviewed])).toBeUndefined()
      expect(shrinkLauncherInventory([stale], [stale, launcherBoundary({ file: "z/added.sh" })])).toBeUndefined()
      expect(shrinkLauncherInventory([stale, reviewed], [launcherBoundary({ file: "b/reviewed.sh", mode: "100644" })])).toBeUndefined()
      expect(shrinkLauncherInventory([stale, reviewed], [launcherBoundary({
        file: "b/reviewed.sh",
        mode: "100755",
        sourceSha256: "3".repeat(64),
        classification: "host-launcher",
        host: "Reviewed host"
      })])).toBeUndefined()
      expect(shrinkLauncherInventory([stale, reviewed], [launcherBoundary({
        file: "b/reviewed.sh",
        mode: "100755",
        sourceSha256: "2".repeat(64),
        classification: "host-fixture",
        host: "Reviewed host"
      })])).toBeUndefined()
      expect(shrinkLauncherInventory([stale, reviewed], [launcherBoundary({
        file: "b/reviewed.sh",
        mode: "100755",
        sourceSha256: "2".repeat(64),
        classification: "host-launcher",
        host: "Changed host"
      })])).toBeUndefined()
      expect(shrinkLauncherInventory([reviewed], [])).toBeUndefined()
      expect(shrinkLauncherInventory([fixtureRecord], [])).toBeUndefined()
    }))
})

describe("Effect tracked mode parser", () => {
  it.effect("parses 40- and 64-character object IDs, preserves unusual paths, and sorts raw paths", () => {
    const first = "scripts/a shell.sh"
    const second = "scripts/z\nname\tpart.zsh"
    const output = [
      `100644 ${"1".repeat(64)} 0\t${second}`,
      `100755 ${"0".repeat(40)} 0\t${first}`
    ].join("\0") + "\0"
    return Effect.gen(function*() {
      const parsed = yield* parseTrackedModes([second, first], output)
      expect(parsed).toEqual([
        { file: first, mode: "100755" },
        { file: second, mode: "100644" }
      ])
    })
  })

  it.effect("rejects malformed metadata, conflict stages, invalid object IDs, and unsupported Git modes", () =>
    Effect.forEach([
      `100644 ${"0".repeat(40)} 1\tscripts/a.sh\0`,
      `100644 ${"A".repeat(40)} 0\tscripts/a.sh\0`,
      `100644 ${"0".repeat(39)} 0\tscripts/a.sh\0`,
      `100664 ${"0".repeat(40)} 0\tscripts/a.sh\0`,
      `100644 ${"0".repeat(40)}\tscripts/a.sh\0`,
      `100644 ${"0".repeat(40)} 0 scripts/a.sh\0`
    ], (output) => Effect.gen(function*() {
      const error = yield* parseTrackedModes(["scripts/a.sh"], output).pipe(Effect.flip)
      expect(error.reason).toBe("invalid-output")
    })))

  it.effect("requires an exact path bijection across both tracked manifests", () => {
    const record = (file: string) => `100644 ${"0".repeat(40)} 0\t${file}`
    return Effect.forEach([
      { tracked: ["scripts/a.sh", "scripts/a.sh"], output: `${record("scripts/a.sh")}\0` },
      { tracked: ["scripts/a.sh"], output: `${record("scripts/a.sh")}\0${record("scripts/a.sh")}\0` },
      { tracked: ["scripts/a.sh", "scripts/b.sh"], output: `${record("scripts/a.sh")}\0` },
      { tracked: ["scripts/a.sh"], output: `${record("scripts/a.sh")}\0${record("scripts/b.sh")}\0` },
      { tracked: ["../scripts/a.sh"], output: `${record("../scripts/a.sh")}\0` }
    ], ({ tracked, output }) => Effect.gen(function*() {
      const error = yield* parseTrackedModes(tracked, output).pipe(Effect.flip)
      expect(error.reason).toBe("invalid-output")
    }))
  })
})

describe("Effect launcher inventory command", () => {
  it.effect("rejects a missing launcher registry in check and update modes without creating it", () =>
    fixture({ baseline: [], omitLauncherInventory: true }, ({ root }) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const check = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
        const update = yield* runAudit({ root, mode: "update" }).pipe(Effect.flip)

        expect(check).toMatchObject({ reason: "baseline-missing", detail: expect.stringContaining("effect-launchers.json") })
        expect(update).toMatchObject({ reason: "baseline-missing", detail: expect.stringContaining("effect-launchers.json") })
        expect(yield* fs.exists(`${root}/effect-launchers.json`)).toBe(false)
      })))

  it.effect("discovers executable files and lower-case shell extensions while ignoring ordinary files", () =>
    Effect.gen(function*() {
      const launcherFiles = [
        { file: "bin/extensionless", mode: "100755" as const, source: "#!/bin/sh\nexit 0\n" },
        { file: "scripts/plain.bash", mode: "100644" as const, source: "#!/bin/bash\nexit 0\n" },
        { file: "scripts/plain.sh", mode: "100644" as const, source: "#!/bin/sh\nexit 0\n" },
        { file: "scripts/plain.zsh", mode: "100644" as const, source: "#!/bin/zsh\nexit 0\n" }
      ]
      const inventory = yield* Effect.forEach(launcherFiles, (entry) => launcherForSource(entry))
      yield* fixture({ baseline: [], launcherFiles, launcherInventory: inventory }, ({ root }) =>
        Effect.gen(function*() {
          const result = yield* runAudit({ root, mode: "check" })

          expect(result.launchers.map(({ file }) => file)).toEqual(launcherFiles.map(({ file }) => file))
          expect(result.launcherAdded).toEqual([])
          expect(result.launcherRemoved).toEqual([])
          expect(result.launcherModeChanged).toEqual([])
          expect(result.launcherSourceChanged).toEqual([])
          expect(result.launcherCounts).toEqual({
            "host-launcher": 0,
            "host-fixture": 0,
            "migration-debt": 4
          })
        }))
    }))

  it.effect("types selected symlinks, submodules, and missing source bytes as invalid output", () =>
    Effect.forEach([
      { file: "scripts/link.sh", mode: "120000" as const, source: "target\n", write: true },
      { file: "scripts/module.sh", mode: "160000" as const, source: "target\n", write: true },
      { file: "scripts/missing.sh", mode: "100644" as const, source: "", write: false }
    ], (entry) => fixture({ baseline: [], launcherFiles: [entry] }, ({ root }) =>
      Effect.gen(function*() {
        const error = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
        expect(error.reason).toBe("invalid-output")
      }))))

  it.effect("rejects launcher additions in both modes without writing any ledger", () =>
    fixture({
      baseline: [finding()],
      inventory: [candidate({ file: "a/stale.ts" })],
      launcherFiles: [{ file: "bin/new-launcher", mode: "100755", source: "#!/bin/sh\nexit 0\n" }]
    }, ({ root }) => Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const files = ["effect-audit-baseline.json", "effect-grep-inventory.json", "effect-launchers.json"]
      const before = yield* Effect.forEach(files, (file) => fs.readFileString(`${root}/${file}`))
      const check = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
      const update = yield* runAudit({ root, mode: "update" }).pipe(Effect.flip)
      const after = yield* Effect.forEach(files, (file) => fs.readFileString(`${root}/${file}`))

      expect(check.reason).toBe("new-findings")
      expect(update.reason).toBe("baseline-growth")
      expect(after).toEqual(before)
    })))

  it.effect("rejects tracked mode and source-byte drift without refreshing the registry", () =>
    Effect.gen(function*() {
      const source = "#!/bin/sh\nexit 0\n"
      const original = yield* launcherForSource({ file: "scripts/tool.sh", mode: "100644", source })
      const sourceDrift = yield* launcherForSource({ file: "scripts/tool.sh", mode: "100644", source: `${source}echo changed\n` })
      yield* fixture({
        baseline: [],
        launcherFiles: [{ file: "scripts/tool.sh", mode: "100755", source }],
        launcherInventory: [original]
      }, ({ root }) => Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const before = yield* fs.readFileString(`${root}/effect-launchers.json`)
        const check = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
        const update = yield* runAudit({ root, mode: "update" }).pipe(Effect.flip)
        expect(check.reason).toBe("new-findings")
        expect(update.reason).toBe("baseline-growth")
        expect(yield* fs.readFileString(`${root}/effect-launchers.json`)).toBe(before)
      }))
      yield* fixture({
        baseline: [],
        launcherFiles: [{ file: "scripts/tool.sh", mode: "100644", source: `${source}echo changed\n` }],
        launcherInventory: [original]
      }, ({ root }) => Effect.gen(function*() {
        const error = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
        expect(error.reason).toBe("new-findings")
        expect(error.detail).toContain("source")
        expect(sourceDrift.sourceSha256).not.toBe(original.sourceSha256)
      }))
    }))

  it.effect("keeps deleted launcher debt stale until update removes it", () => {
    const stale = launcherBoundary()
    return fixture({ baseline: [], launcherInventory: [stale] }, ({ root }) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const check = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
        expect(check.reason).toBe("stale-baseline")

        const updated = yield* runAudit({ root, mode: "update" })
        expect(updated.launcherRemoved).toEqual([stale])
        expect(yield* Schema.decodeUnknownEffect(LauncherInventoryJson)(
          yield* fs.readFileString(`${root}/effect-launchers.json`)
        )).toEqual([])
        yield* runAudit({ root, mode: "check" })
      }))
  })

  it.effect("never removes a stale host launcher or host fixture", () =>
    Effect.forEach(["host-launcher", "host-fixture"] as const, (classification) =>
      fixture({
        baseline: [],
        launcherInventory: [launcherBoundary({ classification, host: "Reviewed permanent host" })]
      }, ({ root }) => Effect.gen(function*() {
        const check = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
        const update = yield* runAudit({ root, mode: "update" }).pipe(Effect.flip)
        expect(check.reason).toBe("stale-baseline")
        expect(update.reason).toBe("baseline-growth")
      }))))

  it.effect("accepts the current and Task 6 host-launcher grammar", () =>
    Effect.gen(function*() {
      for (const source of [
        "#!/bin/sh\nset -e\necho \"gate\"\nnpm run lint\n",
        "#!/bin/sh\nset -e\necho 'gate'\nnpm run effect:audit\n"
      ]) {
        const record = yield* launcherForSource({
          file: ".githooks/test-hook",
          mode: "100755",
          source,
          classification: "host-launcher",
          host: "Git test hook"
        })
        yield* fixture({
          baseline: [],
          launcherFiles: [{ file: record.file, mode: "100755", source }],
          launcherInventory: [record]
        }, ({ root }) => runAudit({ root, mode: "check" }).pipe(Effect.asVoid))
      }
    }))

  it.effect("rejects arbitrary, redirected, composed, or unresolved host-launcher commands", () =>
    Effect.gen(function*() {
      const bodies = [
        "npm run lint\n",
        "#!/bin/sh\n",
        "#!/bin/sh\nrm -rf tmp\n",
        "#!/bin/sh\nnpm run lint -- --fix\n",
        "#!/bin/sh\nnpm run lint > result\n",
        "#!/bin/sh\nnpm run lint | tee result\n",
        "#!/bin/sh\nnpm run lint &\n",
        "#!/bin/sh\necho \"$(pwd)\"\n",
        "#!/bin/sh\nVALUE=1\n",
        "#!/bin/sh\nrun() { npm run lint; }\n",
        "#!/bin/sh\nfor x in lint; do npm run $x; done\n",
        "#!/bin/sh\nnpm run unknown-selector\n",
        "#!/bin/sh\nnpm run toString\n",
        "#!/bin/sh\n npm run lint\n"
      ]
      for (const source of bodies) {
        const record = yield* launcherForSource({
          file: ".githooks/test-hook",
          mode: "100755",
          source,
          classification: "host-launcher",
          host: "Git test hook"
        })
        yield* fixture({
          baseline: [],
          launcherFiles: [{ file: record.file, mode: "100755", source }],
          launcherInventory: [record]
        }, ({ root }) => Effect.gen(function*() {
          const error = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
          expect(error.reason).toBe("invalid-output")
        }))
      }
      const source = "#!/bin/sh\nnpm run lint\n"
      const record = yield* launcherForSource({
        file: "scripts/not-a-hook.sh",
        mode: "100755",
        source,
        classification: "host-launcher",
        host: "Not a hook"
      })
      yield* fixture({
        baseline: [],
        launcherFiles: [{ file: record.file, mode: "100755", source }],
        launcherInventory: [record]
      }, ({ root }) => Effect.gen(function*() {
        const error = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
        expect(error.reason).toBe("invalid-output")
      }))
      const nonExecutable = yield* launcherForSource({
        file: ".githooks/non-executable.sh",
        mode: "100644",
        source,
        classification: "host-launcher",
        host: "Non-executable hook"
      })
      yield* fixture({
        baseline: [],
        launcherFiles: [{ file: nonExecutable.file, mode: "100644", source }],
        launcherInventory: [nonExecutable]
      }, ({ root }) => Effect.gen(function*() {
        const error = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
        expect(error.reason).toBe("invalid-output")
      }))
    }), 60_000)

  it.effect("requires exact AST string-literal proof for host fixtures", () =>
    Effect.gen(function*() {
      const fixtureFile = "scripts/fixture.sh"
      const fixtureSource = "#!/bin/sh\nexit 0\n"
      const record = yield* launcherForSource({
        file: fixtureFile,
        mode: "100644",
        source: fixtureSource,
        classification: "host-fixture",
        host: "Shell test fixture"
      })
      yield* fixture({
        baseline: [],
        sampleFile: "test/sample.test.ts",
        source: `export const fixture = "${fixtureFile}"\n`,
        launcherFiles: [{ file: fixtureFile, mode: "100644", source: fixtureSource }],
        launcherInventory: [record]
      }, ({ root }) => runAudit({ root, mode: "check" }).pipe(Effect.asVoid))

      for (const source of [
        `// ${fixtureFile}\nexport const fixture = "other"\n`,
        `export const fixture = "prefix ${fixtureFile}"\n`,
        "const name = \"fixture\"\nexport const fixture = `scripts/${name}.sh`\n"
      ]) {
        yield* fixture({
          baseline: [],
          sampleFile: "test/sample.test.ts",
          source,
          launcherFiles: [{ file: fixtureFile, mode: "100644", source: fixtureSource }],
          launcherInventory: [record]
        }, ({ root }) => Effect.gen(function*() {
          const error = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
          expect(error.reason).toBe("invalid-output")
        }))
      }

      yield* fixture({
        baseline: [],
        source: `export const fixture = "${fixtureFile}"\n`,
        launcherFiles: [{ file: fixtureFile, mode: "100644", source: fixtureSource }],
        launcherInventory: [record]
      }, ({ root }) => Effect.gen(function*() {
        const error = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
        expect(error.reason).toBe("invalid-output")
      }))
    }))

  it.effect("removes launcher debt without changing surviving reviewed bytes", () =>
    Effect.gen(function*() {
      const source = "#!/bin/sh\nset -e\necho \"gate\"\nnpm run lint\n"
      const reviewed = yield* launcherForSource({
        file: ".githooks/test-hook",
        mode: "100755",
        source,
        classification: "host-launcher",
        host: "Preserve reviewed bytes"
      })
      const stale = launcherBoundary({ file: "z/stale.sh" })
      const before = yield* Schema.encodeEffect(LauncherInventoryJson)([reviewed, stale])
      const reviewedOnly = yield* Schema.encodeEffect(LauncherInventoryJson)([reviewed])
      yield* fixture({
        baseline: [],
        launcherFiles: [{ file: reviewed.file, mode: "100755", source }],
        launcherInventory: before
      }, ({ root }) => Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        yield* runAudit({ root, mode: "update" })
        const after = yield* fs.readFileString(`${root}/effect-launchers.json`)
        expect(after).toBe(reviewedOnly)
        expect(before).toContain(reviewedOnly.slice(1, -1))
      }))
    }))

  it.effect("validates all three ledgers before writing any shrink", () =>
    Effect.gen(function*() {
      const keyword = ["as", "ync"].join("")
      const source = `export const sample = ${keyword} () => 1\n`
      const staleLauncher = launcherBoundary()
      yield* fixture({
        baseline: [finding()],
        inventory: [],
        launcherInventory: [staleLauncher],
        source,
        grepJson: grepJson(grepMatch("src/sample.ts", source, 1, keyword))
      }, ({ root }) => Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const files = ["effect-audit-baseline.json", "effect-grep-inventory.json", "effect-launchers.json"]
        const before = yield* Effect.forEach(files, (file) => fs.readFileString(`${root}/${file}`))
        const error = yield* runAudit({ root, mode: "update" }).pipe(Effect.flip)
        const after = yield* Effect.forEach(files, (file) => fs.readFileString(`${root}/${file}`))
        expect(error.reason).toBe("baseline-growth")
        expect(after).toEqual(before)
      }))

      yield* fixture({
        baseline: [finding()],
        inventory: [candidate({ file: "a/stale.ts" })],
        launcherInventory: "[ ]"
      }, ({ root }) => Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const files = ["effect-audit-baseline.json", "effect-grep-inventory.json", "effect-launchers.json"]
        const before = yield* Effect.forEach(files, (file) => fs.readFileString(`${root}/${file}`))
        const error = yield* runAudit({ root, mode: "update" }).pipe(Effect.flip)
        const after = yield* Effect.forEach(files, (file) => fs.readFileString(`${root}/${file}`))
        expect(error).toMatchObject({ reason: "invalid-output", detail: expect.stringContaining("canonical") })
        expect(after).toEqual(before)
      }))
    }))

  it("rejects NUL launcher paths before shrink authority", () => {
    const malformed = launcherBoundary({ file: "scripts/x\u0000.sh" })

    expect(launcherInventoryValidationError([malformed])).toBe(
      "launcher inventory contains a malformed repository-relative path"
    )
    expect(shrinkLauncherInventory([malformed], [])).toBeUndefined()
  })

  it.effect("rejects a canonical NUL launcher record without writing any ledger", () =>
    Effect.gen(function*() {
      const malformed = launcherBoundary({ file: "scripts/x\u0000.sh" })
      const encoded = yield* Schema.encodeEffect(LauncherInventoryJson)([malformed])
      const decoded = yield* Schema.decodeUnknownEffect(LauncherInventoryJson)(encoded)
      expect(yield* Schema.encodeEffect(LauncherInventoryJson)(decoded)).toBe(encoded)

      yield* fixture({
        baseline: [finding()],
        inventory: [candidate({ file: "a/stale.ts" })],
        launcherInventory: encoded
      }, ({ root }) => Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const files = ["effect-audit-baseline.json", "effect-grep-inventory.json", "effect-launchers.json"]
        const before = yield* Effect.forEach(files, (file) => fs.readFileString(`${root}/${file}`))
        const error = yield* runAudit({ root, mode: "update" }).pipe(Effect.flip)
        const after = yield* Effect.forEach(files, (file) => fs.readFileString(`${root}/${file}`))

        expect(error).toMatchObject({ reason: "invalid-output", detail: expect.stringContaining("path") })
        expect(after).toEqual(before)
      }))
    }))

  it.effect("preserves every ledger byte when launcher drift rejects removable debt", () =>
    Effect.gen(function*() {
      const source = "#!/bin/sh\nexit 0\n"
      const original = yield* launcherForSource({ file: "scripts/tool.sh", mode: "100644", source })
      for (const drift of [
        { kind: "mode", mode: "100755" as const, source },
        { kind: "source", mode: "100644" as const, source: "#!/bin/sh\nexit 1\n" }
      ]) {
        yield* fixture({
          baseline: [finding()],
          inventory: [candidate({ file: "a/stale.ts" })],
          launcherFiles: [{ file: original.file, mode: drift.mode, source: drift.source }],
          launcherInventory: [original]
        }, ({ root }) => Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const files = ["effect-audit-baseline.json", "effect-grep-inventory.json", "effect-launchers.json"]
          const before = yield* Effect.forEach(files, (file) => fs.readFileString(`${root}/${file}`))
          const error = yield* runAudit({ root, mode: "update" }).pipe(Effect.flip)
          const after = yield* Effect.forEach(files, (file) => fs.readFileString(`${root}/${file}`))

          expect(error.reason).toBe("baseline-growth")
          expect(error.detail).toContain(drift.kind)
          expect(after).toEqual(before)
        }))
      }
    }))
})

import { effectHostBoundaries } from "../eslint-rules/effect-host-boundaries.mjs"

const nodeOs = ["node", "os"].join(":")
const nodeCrypto = ["node", "crypto"].join(":")
const nodeHttp = ["node", "http"].join(":")
const hostProcessCwd = ["process", "cwd"].join(".")
const hostProcessKill = ["process", "kill"].join(".")
const hostProcessPid = ["process", "pid"].join(".")
const hostProcessUmask = ["process", "umask"].join(".")
const nodeRuntimeRunMain = ["NodeRuntime", "runMain"].join(".")
const effectRunPromise = ["Effect", "runPromise"].join(".")
const effectRunFork = ["Effect", "runFork"].join(".")
const hostProcessExecPath = ["process", "execPath"].join(".")
const hostProcessPlatform = ["process", "platform"].join(".")
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
  "scripts/cert-cli-build.test.ts": dynamicImportBoundarySource,
  "scripts/cert-cli-build.ts": bracketRunnerBoundarySource,
  "scripts/desktop-command.test.ts": dynamicImportBoundarySource,
  "scripts/desktop-command.ts": bracketRunnerBoundarySource,
  "scripts/effect-audit.ts": runnerBoundarySource,
  "scripts/fold-version.ts": runnerBoundarySource,
  "scripts/sync-agents.test.ts": `import { Effect } from "effect"
Effect.promise(() => import("effect"))
`,
  "scripts/sync-agents.ts": runnerBoundarySource,
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
      baseline: [],
      inventory: [reviewed],
      grepJson: grepJson(grepMatch(
        "apps/cli/cli/node-app-context.ts",
        line,
        5,
        hostProcessCwd,
        undefined,
        byteOffsetAtLine(appContextBoundarySource, 5)
      ))
    }, ({ root }) => runAudit({ root, mode: "check" }).pipe(Effect.asVoid))
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
      baseline: [],
      inventory: [reviewed],
      source,
      grepJson: grepJson(grepMatch("src/sample.ts", source, 1, asyncKeyword))
    }, ({ root }) =>
      Effect.gen(function*() {
        const error = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
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

    return fixture({ baseline: [], languageService: registered }, ({ root }) =>
      runAudit({ root, mode: "check" }).pipe(Effect.asVoid)
    ).pipe(Effect.andThen(
      fixture({
        baseline: [],
        source: unregisteredSource,
        languageService: unregistered
      }, ({ root }) =>
        Effect.gen(function*() {
          const error = yield* runAudit({ root, mode: "check" }).pipe(Effect.flip)
          expect(error).toMatchObject({
            reason: "new-findings",
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
