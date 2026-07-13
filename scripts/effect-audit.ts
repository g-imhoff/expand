import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Linter, type SourceCode } from "eslint"
import { Context, Effect, FileSystem, Layer, Path, Schema, Stream } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import tseslint from "typescript-eslint"
import { analyzeEffectBoundaryProgram } from "../eslint-rules/effect-boundary-analysis.mjs"
import { effectHostBoundaries } from "../eslint-rules/effect-host-boundaries.mjs"
import {
  AuditBaselineJson,
  AuditFinding,
  EffectAuditError,
  compareAudit,
  findingKey
} from "./effect-audit-model"
import { NonNegativeInt, PositiveInt, type HostBoundary } from "./effect-policy-model"

export interface AuditCommandRequest {
  readonly name: "language-service" | "eslint" | "typescript-files" | "tracked-files" | "tracked-modes"
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly acceptedExitCodes: ReadonlyArray<number>
}

export interface AuditCommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export class AuditCommandRunner extends Context.Service<AuditCommandRunner, {
  readonly run: (request: AuditCommandRequest) => Effect.Effect<AuditCommandResult, EffectAuditError>
}>()("expand/AuditCommandRunner") {}

const LanguageDiagnostic = Schema.Struct({
  file: Schema.String,
  start: NonNegativeInt,
  length: NonNegativeInt,
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
  severity: Schema.Int,
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

const typeScriptFile = /\.(?:ts|tsx|mts|cts)$/u
const sourceFile = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u
const broadText = /[*?[\]{}]/u

const auditError = (
  reason: EffectAuditError["reason"],
  detail?: string,
  findings: ReadonlyArray<AuditFinding> = []
) => new EffectAuditError({ reason, findings, ...(detail === undefined ? {} : { detail }) })

const commandRequests = (root: string): ReadonlyArray<AuditCommandRequest> => [{
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

const runCommand = Effect.fn("effect-audit.command")(
  function*(runner: AuditCommandRunner["Service"], request: AuditCommandRequest) {
    const result = yield* runner.run(request)
    if (!request.acceptedExitCodes.includes(result.exitCode)) {
      return yield* Effect.fail(auditError(
        "command-failed",
        `${request.name} exited ${result.exitCode}: ${result.stderr.trim()}`
      ))
    }
    return result
  }
)

const decodeRequiredJson = Effect.fn("effect-audit.decodeJson")(
  function* <S extends Schema.Top>(name: string, schema: S, text: string) {
    if (text.trim().length === 0) {
      return yield* Effect.fail(auditError("invalid-output", `${name} returned empty JSON`))
    }
    return yield* Schema.decodeUnknownEffect(schema)(text).pipe(
      Effect.mapError((cause) => auditError("invalid-output", `${name} returned invalid JSON: ${String(cause)}`))
    )
  }
)

const normalizeRepositoryPath = (root: string, file: string, path: Path.Path) => {
  const absolute = path.isAbsolute(file) ? file : path.resolve(root, file)
  const relative = path.relative(root, absolute)
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined
  return relative.split(path.sep).join("/").replace(/^\.\//u, "")
}

const normalizedCounts = (root: string, files: ReadonlyArray<string>, path: Path.Path) => {
  const counts = new Map<string, number>()
  for (const file of files) {
    const normalized = normalizeRepositoryPath(root, file, path)
    if (normalized === undefined || normalized.length === 0) continue
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1)
  }
  return counts
}

const parseIndexModes = (output: string) => {
  const files: Array<string> = []
  for (const entry of output.split("\0")) {
    if (entry.length === 0) continue
    const separator = entry.indexOf("\t")
    if (separator < 0) return undefined
    const header = entry.slice(0, separator).match(/^[0-7]+ [0-9a-f]+ ([0-3])$/u)
    if (header === null) return undefined
    if (header[1] === "0") files.push(entry.slice(separator + 1))
  }
  return files
}

interface ParsedSource {
  readonly analysis: ReturnType<typeof analyzeEffectBoundaryProgram>
  readonly sourceCode: SourceCode
}

const parseSource = Effect.fn("effect-audit.parseSource")(
  function*(root: string, file: string, text: string, typed: boolean) {
    const path = yield* Path.Path
    const absolute = path.resolve(root, file)
    return yield* Effect.try({
      try: () => {
        const linter = new Linter({ configType: "flat", cwd: root })
        const messages = linter.verify(text, {
          files: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
          languageOptions: {
            ecmaVersion: "latest",
            parser: tseslint.parser,
            parserOptions: {
              ecmaFeatures: { jsx: file.endsWith("x") },
              project: typed ? path.join(root, "tsconfig.effect-audit.json") : false,
              projectService: false,
              tsconfigRootDir: root
            },
            sourceType: "module"
          }
        }, {
          allowInlineConfig: false,
          filename: absolute
        })
        const fatal = messages.find((message) => message.fatal === true)
        if (fatal !== undefined) {
          throw new Error(`fatal parser diagnostic ${fatal.line}:${fatal.column}: ${fatal.message}`)
        }
        const sourceCode = linter.getSourceCode()
        return {
          sourceCode,
          analysis: analyzeEffectBoundaryProgram({
            filename: absolute,
            sourceCode,
            parserServices: sourceCode.parserServices
          })
        }
      },
      catch: (cause) => auditError("invalid-output", `cannot parse ${file}: ${String(cause)}`)
    })
  }
)

const loadParsedSource = Effect.fn("effect-audit.loadSource")(
  function*(
    root: string,
    file: string,
    typed: boolean,
    cache: Map<string, ParsedSource>
  ) {
    const key = `${typed ? "typed" : "syntax"}\u0000${file}`
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const text = yield* fs.readFileString(path.join(root, file)).pipe(
      Effect.mapError((cause) => auditError("invalid-output", `cannot read ${file}: ${String(cause)}`))
    )
    const parsed = yield* parseSource(root, file, text, typed)
    cache.set(key, parsed)
    return parsed
  }
)

const identityAtLocation = Effect.fn("effect-audit.identityAtLocation")(
  function*(parsed: ParsedSource, line: number, column: number, fallback: string) {
    const offset = yield* Effect.try({
      try: () => parsed.sourceCode.getIndexFromLoc({ line, column: column - 1 }),
      catch: (cause) => auditError("invalid-output", `invalid diagnostic location: ${String(cause)}`)
    })
    return parsed.analysis.identityAtOffset(offset, fallback)
  }
)

const normalizeLanguageFindings = Effect.fn("effect-audit.normalizeLanguage")(
  function*(
    root: string,
    diagnostics: ReadonlyArray<Schema.Schema.Type<typeof LanguageDiagnostic>>,
    indexed: ReadonlySet<string>,
    cache: Map<string, ParsedSource>
  ) {
    const path = yield* Path.Path
    const findings: Array<AuditFinding> = []
    for (const diagnostic of diagnostics) {
      const file = normalizeRepositoryPath(root, diagnostic.file, path)
      if (file === undefined || !indexed.has(file) || !typeScriptFile.test(file)) continue
      const parsed = yield* loadParsedSource(root, file, true, cache)
      const identity = yield* identityAtLocation(
        parsed,
        diagnostic.line,
        diagnostic.column,
        `diagnostic:${diagnostic.name}`
      )
      findings.push(new AuditFinding({
        engine: "effect-language-service",
        file,
        rule: diagnostic.name,
        declaration: identity.declaration,
        construct: identity.construct,
        occurrence: identity.occurrence,
        severity: diagnostic.severity,
        line: diagnostic.line,
        excerpt: parsed.sourceCode.lines[diagnostic.line - 1] ?? ""
      }))
    }
    return findings
  }
)

const normalizeEslintFindings = Effect.fn("effect-audit.normalizeEslint")(
  function*(
    root: string,
    results: ReadonlyArray<Schema.Schema.Type<typeof EslintOutputJson>[number]>,
    indexed: ReadonlySet<string>,
    cache: Map<string, ParsedSource>
  ) {
    const path = yield* Path.Path
    const findings: Array<AuditFinding> = []
    for (const result of results) {
      const file = normalizeRepositoryPath(root, result.filePath, path)
      if (file === undefined || !indexed.has(file) || !sourceFile.test(file)) continue
      const fatal = result.messages.find((message) => message.fatal === true)
      if (fatal !== undefined) {
        return yield* Effect.fail(auditError("invalid-output", `eslint fatal in ${file}: ${fatal.message}`))
      }
      for (const message of result.messages) {
        if (message.ruleId !== "local/effect-boundary" || message.messageId === "staleBoundary") continue
        if (message.messageId === undefined || message.line === undefined || message.column === undefined) {
          return yield* Effect.fail(auditError("invalid-output", `eslint returned an incomplete finding for ${file}`))
        }
        const parsed = yield* loadParsedSource(root, file, typeScriptFile.test(file), cache)
        const identity = yield* identityAtLocation(
          parsed,
          message.line,
          message.column,
          `diagnostic:${message.messageId}`
        )
        findings.push(new AuditFinding({
          engine: "eslint",
          file,
          rule: message.messageId,
          declaration: identity.declaration,
          construct: identity.construct,
          occurrence: identity.occurrence,
          severity: message.severity === 2 ? "error" : "message",
          line: message.line,
          excerpt: parsed.sourceCode.lines[message.line - 1] ?? ""
        }))
      }
    }
    return findings
  }
)

const uniqueSortedFindings = (findings: ReadonlyArray<AuditFinding>) => [...new Map(
  findings.map((finding) => [findingKey(finding), finding])
)]
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([, finding]) => finding)

const exactText = (value: unknown) => typeof value === "string"
  && value.trim().length > 0
  && !broadText.test(value)

const exactFile = (value: unknown) => exactText(value)
  && typeof value === "string"
  && !value.startsWith("/")
  && !value.endsWith("/")
  && sourceFile.test(value)

const boundaryKey = (boundary: HostBoundary) => [
  boundary.file,
  boundary.declaration,
  boundary.construct,
  String(boundary.occurrence)
].join("\u0000")

const invalidBoundary = (detail: string) => Effect.fail(auditError("invalid-boundary", detail))

export const validateHostBoundaries = Effect.fn("effect-audit.validateHostBoundaries")(
  function*(input: {
    readonly root: string
    readonly boundaries: ReadonlyArray<HostBoundary>
    readonly indexedFiles: ReadonlyArray<string>
    readonly eslintFiles: ReadonlyArray<string>
  }) {
    const path = yield* Path.Path
    for (const [index, boundary] of input.boundaries.entries()) {
      if (!exactFile(boundary.file)
        || !exactText(boundary.declaration)
        || !exactText(boundary.host)
        || !exactText(boundary.construct)
        || !Number.isInteger(boundary.occurrence)
        || boundary.occurrence < 0) {
        return yield* invalidBoundary(`invalid boundary record ${index}`)
      }
    }

    const seen = new Set<string>()
    for (const boundary of input.boundaries) {
      const key = boundaryKey(boundary)
      if (seen.has(key)) return yield* invalidBoundary(`duplicate boundary ${key}`)
      seen.add(key)
    }

    const indexedCounts = normalizedCounts(input.root, input.indexedFiles, path)
    const eslintCounts = normalizedCounts(input.root, input.eslintFiles, path)
    const cache = new Map<string, ParsedSource>()

    for (const boundary of input.boundaries) {
      const file = normalizeRepositoryPath(input.root, boundary.file, path)
      if (file === undefined || indexedCounts.get(file) !== 1) {
        return yield* invalidBoundary(`boundary file must resolve once: ${boundary.file}`)
      }
      if (eslintCounts.get(file) !== 1) {
        return yield* invalidBoundary(`boundary must have exactly one ESLint consumer: ${boundary.file}`)
      }
      const parsed = yield* loadParsedSource(input.root, file, typeScriptFile.test(file), cache).pipe(
        Effect.mapError((error) => auditError("invalid-boundary", error.detail))
      )
      if (!parsed.analysis.declarations.has(boundary.declaration)) {
        return yield* invalidBoundary(`boundary declaration is missing: ${boundary.file}:${boundary.declaration}`)
      }
      const matches = parsed.analysis.occurrences.filter((occurrence) =>
        occurrence.identity.declaration === boundary.declaration
        && occurrence.identity.construct === boundary.construct
        && occurrence.identity.occurrence === boundary.occurrence)
      if (matches.length !== 1) {
        return yield* invalidBoundary(`boundary occurrence must resolve once: ${boundaryKey(boundary)}`)
      }
    }
  }
)

const validateBaseline = (baseline: ReadonlyArray<AuditFinding>) => {
  if (baseline.some((finding) => finding.severity !== "error")) {
    return "baseline contains a non-error finding"
  }
  const keys = baseline.map(findingKey)
  if (new Set(keys).size !== keys.length) return "baseline contains duplicate finding keys"
  const sorted = [...keys].sort((left, right) => left.localeCompare(right))
  if (keys.some((key, index) => key !== sorted[index])) return "baseline is not sorted by findingKey"
  return undefined
}

const readBaseline = Effect.fn("effect-audit.readBaseline")(
  function*(root: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const file = path.join(root, "effect-audit-baseline.json")
    const exists = yield* fs.exists(file).pipe(
      Effect.mapError((cause) => auditError("invalid-output", `cannot inspect baseline: ${String(cause)}`))
    )
    if (!exists) return yield* Effect.fail(auditError("baseline-missing", "effect-audit-baseline.json is missing"))
    const text = yield* fs.readFileString(file).pipe(
      Effect.mapError((cause) => auditError("invalid-output", `cannot read baseline: ${String(cause)}`))
    )
    const baseline = yield* decodeRequiredJson("baseline", AuditBaselineJson, text)
    const invalid = validateBaseline(baseline)
    if (invalid !== undefined) return yield* Effect.fail(auditError("invalid-output", invalid))
    return baseline
  }
)

const writeBaseline = Effect.fn("effect-audit.writeBaseline")(
  function*(root: string, findings: ReadonlyArray<AuditFinding>) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const encoded = yield* Schema.encodeEffect(AuditBaselineJson)([...findings]).pipe(
      Effect.mapError((cause) => auditError("invalid-output", `cannot encode baseline: ${String(cause)}`))
    )
    yield* fs.writeFileString(path.join(root, "effect-audit-baseline.json"), `${encoded}\n`).pipe(
      Effect.mapError((cause) => auditError("invalid-output", `cannot write baseline: ${String(cause)}`))
    )
  }
)

const collectAudit = Effect.fn("effect-audit.collect")(
  function*(runner: AuditCommandRunner["Service"], options: {
    readonly root: string
    readonly mode: "check" | "update"
  }) {
    const path = yield* Path.Path
    const responses = new Map<AuditCommandRequest["name"], AuditCommandResult>()
    for (const request of commandRequests(options.root)) {
      responses.set(request.name, yield* runCommand(runner, request))
    }

    const language = yield* decodeRequiredJson(
      "language-service",
      LanguageOutputJson,
      responses.get("language-service")?.stdout ?? ""
    )
    const eslint = yield* decodeRequiredJson(
      "eslint",
      EslintOutputJson,
      responses.get("eslint")?.stdout ?? ""
    )
    const trackedOutput = responses.get("tracked-files")?.stdout ?? ""
    const modeOutput = responses.get("tracked-modes")?.stdout ?? ""
    const modeFiles = parseIndexModes(modeOutput)
    if (trackedOutput.length === 0 || modeOutput.length === 0 || modeFiles === undefined) {
      return yield* Effect.fail(auditError("invalid-output", "git returned an invalid index manifest"))
    }
    const trackedFiles = trackedOutput.split("\0").filter((file) => file.length > 0)
    const trackedCounts = normalizedCounts(options.root, trackedFiles, path)
    const modeCounts = normalizedCounts(options.root, modeFiles, path)
    if (trackedCounts.size !== modeCounts.size
      || [...trackedCounts].some(([file, count]) => count !== 1 || modeCounts.get(file) !== 1)) {
      return yield* Effect.fail(auditError("invalid-output", "git index manifests disagree"))
    }
    const indexed = new Set(modeCounts.keys())
    const indexedTypeScript = [...indexed].filter((file) => typeScriptFile.test(file)).sort()
    const indexedSources = [...indexed].filter((file) => sourceFile.test(file)).sort()

    const resolvedTypeScript = new Set((responses.get("typescript-files")?.stdout ?? "")
      .split(/\r?\n/u)
      .map((file) => normalizeRepositoryPath(options.root, file, path))
      .filter((file): file is string => file !== undefined && typeScriptFile.test(file)))
    const missingTypeScript = indexedTypeScript.filter((file) => !resolvedTypeScript.has(file))
    if (missingTypeScript.length > 0) {
      return yield* Effect.fail(auditError("coverage-gap", `TypeScript omitted ${missingTypeScript.join(", ")}`))
    }

    const eslintFiles = eslint
      .map((result) => normalizeRepositoryPath(options.root, result.filePath, path))
      .filter((file): file is string => file !== undefined && indexed.has(file))
    const eslintSet = new Set(eslintFiles)
    const missingEslint = indexedSources.filter((file) => !eslintSet.has(file))
    if (missingEslint.length > 0) {
      return yield* Effect.fail(auditError("coverage-gap", `ESLint omitted ${missingEslint.join(", ")}`))
    }

    yield* validateHostBoundaries({
      root: options.root,
      boundaries: effectHostBoundaries,
      indexedFiles: modeFiles,
      eslintFiles
    })

    const cache = new Map<string, ParsedSource>()
    const languageFindings = yield* normalizeLanguageFindings(
      options.root,
      language.diagnostics,
      indexed,
      cache
    )
    const eslintFindings = yield* normalizeEslintFindings(options.root, eslint, indexed, cache)
    const findings = uniqueSortedFindings([...languageFindings, ...eslintFindings])
    const blocking = findings.filter((finding) => finding.severity === "error")
    const advisory = findings.filter((finding) => finding.severity === "message")
    const baseline = yield* readBaseline(options.root)
    const comparison = compareAudit(baseline, blocking)

    if (comparison.added.length > 0) {
      return yield* Effect.fail(auditError(
        options.mode === "update" ? "baseline-growth" : "new-findings",
        `${comparison.added.length} new finding keys`,
        comparison.added
      ))
    }
    if (options.mode === "check" && comparison.removed.length > 0) {
      return yield* Effect.fail(auditError(
        "stale-baseline",
        `${comparison.removed.length} stale baseline keys`,
        comparison.removed
      ))
    }
    if (options.mode === "update") yield* writeBaseline(options.root, blocking)

    return { blocking, advisory }
  }
)

export const runAudit = Effect.fn("effect-audit.run")(
  function* (options: { readonly root: string; readonly mode: "check" | "update" }) {
    const runner = yield* AuditCommandRunner
    return yield* collectAudit(runner, options)
  }
)

export const AuditCommandRunnerLive = Layer.effect(AuditCommandRunner, Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  return {
    run: (request: AuditCommandRequest) => Effect.scoped(Effect.gen(function*() {
      const handle = yield* spawner.spawn(ChildProcess.make(request.command, request.args, { cwd: request.cwd }))
      const [stdout, stderr, exitCode] = yield* Effect.all([
        handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
        handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
        handle.exitCode
      ], { concurrency: "unbounded" })
      return { exitCode: Number(exitCode), stdout, stderr }
    })).pipe(
      Effect.mapError((cause) => auditError("command-failed", `${request.name}: ${String(cause)}`))
    )
  }
}))

const command = Command.make("effect-audit", { update: Flag.boolean("update") }, ({ update }) => Effect.gen(function*() {
  const path = yield* Path.Path
  const root = yield* path.fromFileUrl(new URL("../", import.meta.url))
  const result = yield* runAudit({ root, mode: update ? "update" : "check" })
  yield* Effect.logInfo(`Effect audit: ${result.blocking.length} errors, ${result.advisory.length} messages`)
}))

const program = Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(AuditCommandRunnerLive),
  Effect.provide(NodeServices.layer)
)

if (import.meta.main) NodeRuntime.runMain(program)
