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
    const sample = "src/sample.ts"
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
      }
    }
    const requests: Array<AuditCommandRequest> = []
    const runner = Layer.succeed(AuditCommandRunner, AuditCommandRunner.of({
      run: (request) => Effect.suspend(() => {
        requests.push(request)
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
