import { NodeRuntime, NodeServices } from "@effect/platform-node"
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
import { HostBoundary, NonNegativeInt, PositiveInt } from "./effect-policy-model"

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

const auditError = (
  reason: EffectAuditError["reason"],
  detail?: string,
  findings: ReadonlyArray<AuditFinding> = []
) => new EffectAuditError({ reason, findings, ...(detail === undefined ? {} : { detail }) })

export const AuditCommandRunnerLive = Layer.effect(
  AuditCommandRunner,
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return AuditCommandRunner.of({
      run: Effect.fn("effect-audit.command")((request: AuditCommandRequest) =>
        Effect.scoped(Effect.gen(function*() {
          const handle = yield* spawner.spawn(ChildProcess.make(request.command, request.args, { cwd: request.cwd }))
          const [stdout, stderr, exitCode] = yield* Effect.all([
            handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
            handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
            handle.exitCode
          ], { concurrency: "unbounded" })
          return { exitCode, stdout, stderr }
        })).pipe(
          Effect.mapError((error) => auditError("command-failed", `${request.name}: ${String(error)}`))
        ))
    })
  })
)

const LanguageDiagnostic = Schema.Struct({
  file: Schema.String,
  start: NonNegativeInt,
  length: Schema.optionalKey(NonNegativeInt),
  line: PositiveInt,
  column: Schema.optionalKey(PositiveInt),
  severity: Schema.Literals(["error", "message"]),
  name: Schema.String,
  message: Schema.String
})

const LanguageServiceJson = Schema.fromJsonString(Schema.Struct({
  diagnostics: Schema.Array(LanguageDiagnostic)
}))

const EslintMessage = Schema.Struct({
  ruleId: Schema.NullOr(Schema.String),
  severity: Schema.Literals([1, 2]),
  message: Schema.String,
  messageId: Schema.optionalKey(Schema.String),
  line: PositiveInt,
  column: PositiveInt,
  fatal: Schema.optionalKey(Schema.Boolean)
})

const EslintResult = Schema.Struct({
  filePath: Schema.String,
  messages: Schema.Array(EslintMessage)
})

const EslintJson = Schema.fromJsonString(Schema.Array(EslintResult))
const HostBoundaries = Schema.Array(HostBoundary)

interface ParsedSource {
  readonly source: string
  readonly analysis: ReturnType<typeof analyzeEffectBoundaryProgram>
}

interface ParserResult {
  readonly ast: unknown
  readonly services?: unknown
  readonly scopeManager?: unknown
  readonly visitorKeys?: unknown
}

interface Parser {
  readonly parseForESLint: (source: string, options: Record<string, unknown>) => ParserResult
}

const parser = tseslint.parser as unknown as Parser

const isTypeScriptFile = (file: string) => /\.(?:ts|tsx|mts|cts)$/.test(file)
const isEslintFile = (file: string) => /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(file)

const normalizeFile = (path: Path.Path, root: string, file: string): string | undefined => {
  const absolute = path.isAbsolute(file) ? file : path.resolve(root, file)
  const relative = path.relative(root, absolute).split(path.sep).join("/")
  if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) return undefined
  return relative
}

const parseSource = Effect.fn("effect-audit.parse-source")(
  function*(root: string, file: string, invalidReason: "invalid-output" | "invalid-boundary") {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const absolute = path.join(root, file)
    const source = yield* fs.readFileString(absolute).pipe(
      Effect.mapError((error) => auditError(invalidReason, `${file}: ${String(error)}`))
    )
    const parsed = yield* Effect.try({
      try: () => parser.parseForESLint(source, {
        filePath: absolute,
        loc: true,
        range: true,
        sourceType: "module",
        ...(isTypeScriptFile(file)
          ? { project: "./tsconfig.effect-audit.json", tsconfigRootDir: root }
          : { project: false })
      }),
      catch: (error) => auditError(invalidReason, `${file}: ${String(error)}`)
    })
    const analysis = yield* Effect.try({
      try: () => analyzeEffectBoundaryProgram({
        filename: file,
        sourceCode: {
          ast: parsed.ast,
          parserServices: parsed.services,
          scopeManager: parsed.scopeManager,
          visitorKeys: parsed.visitorKeys
        },
        parserServices: parsed.services
      }),
      catch: (error) => auditError(invalidReason, `${file}: ${String(error)}`)
    })
    return { source, analysis } satisfies ParsedSource
  }
)

const lineExcerpt = (source: string, line: number): string | undefined =>
  source.split(/\r\n|[\n\r\u2028\u2029]/).at(line - 1)?.trim()

const offsetAt = (source: string, line: number, column: number): number => {
  let offset = 0
  let remaining = Math.max(0, line - 1)
  for (const terminator of source.matchAll(/\r\n|[\n\r\u2028\u2029]/g)) {
    if (remaining === 0) break
    offset = (terminator.index ?? 0) + terminator[0].length
    remaining -= 1
  }
  return offset + Math.max(0, column - 1)
}

const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0

const deduplicateAndSort = (findings: ReadonlyArray<AuditFinding>): ReadonlyArray<AuditFinding> =>
  [...new Map(findings.map((finding) => [findingKey(finding), finding])).values()]
    .sort((left, right) => compareText(findingKey(left), findingKey(right)))

const validBoundaryString = (value: string) =>
  value.length > 0 && value === value.trim() && !/[*?\[\]{}]/.test(value)

const validBoundary = (path: Path.Path, boundary: HostBoundary) => {
  if (!validBoundaryString(boundary.file) || path.isAbsolute(boundary.file)) return false
  if (boundary.file.includes("\\") || boundary.file.endsWith("/")) return false
  if (boundary.file.split("/").some((part) => part === "" || part === "." || part === "..")) return false
  if (!isEslintFile(boundary.file)) return false
  return validBoundaryString(boundary.declaration)
    && validBoundaryString(boundary.host)
    && validBoundaryString(boundary.construct)
}

const boundaryIdentityKey = (boundary: HostBoundary) =>
  [boundary.file, boundary.declaration, boundary.construct, String(boundary.occurrence)].join("\u0000")

export const validateHostBoundaries = Effect.fn("effect-audit.validate-host-boundaries")(
  function*(options: {
    readonly root: string
    readonly trackedFiles: ReadonlyArray<string>
    readonly eslintFiles: ReadonlyArray<string>
    readonly boundaries: ReadonlyArray<HostBoundary>
  }) {
    const path = yield* Path.Path
    const boundaries = yield* Schema.decodeUnknownEffect(HostBoundaries)(options.boundaries).pipe(
      Effect.mapError((error) => auditError("invalid-boundary", String(error)))
    )
    const trackedCounts = new Map<string, number>()
    const eslintCounts = new Map<string, number>()
    for (const file of options.trackedFiles) trackedCounts.set(file, (trackedCounts.get(file) ?? 0) + 1)
    for (const file of options.eslintFiles) eslintCounts.set(file, (eslintCounts.get(file) ?? 0) + 1)

    const identityCounts = new Map<string, number>()
    for (const boundary of boundaries) {
      const key = boundaryIdentityKey(boundary)
      identityCounts.set(key, (identityCounts.get(key) ?? 0) + 1)
    }

    for (const boundary of boundaries) {
      const key = boundaryIdentityKey(boundary)
      if (!validBoundary(path, boundary)) {
        return yield* Effect.fail(auditError("invalid-boundary", `malformed boundary: ${key}`))
      }
      if (trackedCounts.get(boundary.file) !== 1) {
        return yield* Effect.fail(auditError("invalid-boundary", `boundary file is not exactly tracked once: ${boundary.file}`))
      }
      if (eslintCounts.get(boundary.file) !== 1) {
        return yield* Effect.fail(auditError("invalid-boundary", `boundary file has no unique ESLint consumer: ${boundary.file}`))
      }
      if (identityCounts.get(key) !== 1) {
        return yield* Effect.fail(auditError("invalid-boundary", `boundary identity is duplicated: ${key}`))
      }
    }

    const parsed = new Map<string, ParsedSource>()
    for (const boundary of boundaries) {
      let source = parsed.get(boundary.file)
      if (source === undefined) {
        source = yield* parseSource(options.root, boundary.file, "invalid-boundary")
        parsed.set(boundary.file, source)
      }
      const matches = source.analysis.occurrences.filter((occurrence) =>
        occurrence.identity.file === boundary.file
        && occurrence.identity.declaration === boundary.declaration
        && occurrence.identity.construct === boundary.construct
        && occurrence.identity.occurrence === boundary.occurrence
      )
      if (!source.analysis.declarations.has(boundary.declaration) || matches.length !== 1) {
        return yield* Effect.fail(auditError("invalid-boundary", `boundary is unconsumed or ambiguous: ${boundaryIdentityKey(boundary)}`))
      }
    }
  }
)

const commandRequests = (root: string): ReadonlyArray<AuditCommandRequest> => [
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
]

const runCommand = Effect.fn("effect-audit.run-command")(
  function*(runner: AuditCommandRunner["Service"], request: AuditCommandRequest) {
    const result = yield* runner.run(request)
    if (!request.acceptedExitCodes.includes(result.exitCode)) {
      return yield* Effect.fail(auditError(
        "command-failed",
        `${request.name} exited with ${result.exitCode}${result.stderr.length > 0 ? `: ${result.stderr}` : ""}`
      ))
    }
    if (result.stdout.length === 0) {
      return yield* Effect.fail(auditError("invalid-output", `${request.name} produced empty stdout`))
    }
    return result
  }
)

const decodeJson = <A, I>(schema: Schema.Codec<A, I>, input: unknown, command: string) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError((error) => auditError("invalid-output", `${command}: ${String(error)}`))
  )

const validateTrackedModes = (
  tracked: ReadonlyArray<string>,
  output: string
): Effect.Effect<void, EffectAuditError> => Effect.gen(function*() {
  const modes = new Map<string, number>()
  for (const entry of output.split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t")
    const header = tab < 0 ? [] : entry.slice(0, tab).split(" ")
    const file = tab < 0 ? "" : entry.slice(tab + 1)
    if (header.length !== 3 || header[2] !== "0" || file.length === 0) {
      return yield* Effect.fail(auditError("invalid-output", `tracked-modes contains an invalid record: ${entry}`))
    }
    modes.set(file, (modes.get(file) ?? 0) + 1)
  }
  for (const file of tracked) {
    if (modes.get(file) !== 1) {
      return yield* Effect.fail(auditError("invalid-output", `tracked-modes does not resolve ${file} exactly once`))
    }
  }
})

const validateBaseline = (
  baseline: ReadonlyArray<AuditFinding>
): Effect.Effect<ReadonlyArray<AuditFinding>, EffectAuditError> => Effect.gen(function*() {
  const keys = baseline.map(findingKey)
  const sorted = [...keys].sort(compareText)
  if (baseline.some((finding) => finding.severity !== "error")) {
    return yield* Effect.fail(auditError("invalid-output", "baseline contains an advisory message"))
  }
  if (new Set(keys).size !== keys.length) {
    return yield* Effect.fail(auditError("invalid-output", "baseline contains duplicate finding identities"))
  }
  if (keys.some((key, index) => key !== sorted[index])) {
    return yield* Effect.fail(auditError("invalid-output", "baseline is not sorted by finding identity"))
  }
  return baseline
})

const collectAudit = Effect.fn("effect-audit.collect")(
  function*(runner: AuditCommandRunner["Service"], options: {
    readonly root: string
    readonly mode: "check" | "update"
  }) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const results = new Map<AuditCommandRequest["name"], AuditCommandResult>()
    for (const request of commandRequests(options.root)) {
      results.set(request.name, yield* runCommand(runner, request))
    }
    const output = (name: AuditCommandRequest["name"]) => results.get(name)?.stdout ?? ""

    const tracked = output("tracked-files").split("\0").filter(Boolean)
    if (new Set(tracked).size !== tracked.length) {
      return yield* Effect.fail(auditError("invalid-output", "tracked manifest contains duplicate paths"))
    }
    yield* validateTrackedModes(tracked, output("tracked-modes"))
    const trackedSet = new Set(tracked)
    const languageService = yield* decodeJson(LanguageServiceJson, output("language-service"), "language-service")
    const eslint = yield* decodeJson(EslintJson, output("eslint"), "eslint")

    const typeScriptFiles = new Set(
      output("typescript-files").split(/\r?\n/)
        .map((file) => normalizeFile(path, options.root, file))
        .filter((file): file is string => file !== undefined)
    )
    const eslintFiles = eslint
      .map((result) => normalizeFile(path, options.root, result.filePath))
      .filter((file): file is string => file !== undefined)
    const eslintFileSet = new Set(eslintFiles)
    const missingTypeScript = tracked.filter((file) => isTypeScriptFile(file) && !typeScriptFiles.has(file))
    const missingEslint = tracked.filter((file) => isEslintFile(file) && !eslintFileSet.has(file))
    if (missingTypeScript.length > 0 || missingEslint.length > 0) {
      return yield* Effect.fail(auditError(
        "coverage-gap",
        [...missingTypeScript.map((file) => `typescript:${file}`), ...missingEslint.map((file) => `eslint:${file}`)].join(", ")
      ))
    }

    yield* validateHostBoundaries({
      root: options.root,
      trackedFiles: tracked,
      eslintFiles,
      boundaries: effectHostBoundaries
    })

    const relevantLanguage = languageService.diagnostics.flatMap((diagnostic) => {
      const file = normalizeFile(path, options.root, diagnostic.file)
      return file !== undefined && trackedSet.has(file) ? [{ file, diagnostic }] : []
    })
    const relevantEslint = eslint.flatMap((result) => {
      const file = normalizeFile(path, options.root, result.filePath)
      return file !== undefined && trackedSet.has(file)
        ? result.messages.map((message) => ({ file, message }))
        : []
    })
    const sourceFiles = new Set([
      ...relevantLanguage.map(({ file }) => file),
      ...relevantEslint.map(({ file }) => file)
    ])
    const sources = new Map<string, ParsedSource>()
    for (const file of sourceFiles) sources.set(file, yield* parseSource(options.root, file, "invalid-output"))

    const languageFindings = relevantLanguage.map(({ diagnostic, file }) => {
      const parsed = sources.get(file)!
      const identity = parsed.analysis.identityAtOffset(diagnostic.start, `diagnostic:${diagnostic.name}`)
      const excerpt = lineExcerpt(parsed.source, diagnostic.line)
      return new AuditFinding({
        engine: "effect-language-service",
        file,
        rule: diagnostic.name,
        declaration: identity.declaration,
        construct: identity.construct,
        occurrence: identity.occurrence,
        severity: diagnostic.severity,
        line: diagnostic.line,
        ...(excerpt === undefined ? {} : { excerpt })
      })
    })
    const eslintFindings = relevantEslint.map(({ file, message }) => {
      const parsed = sources.get(file)!
      const rule = message.messageId ?? message.ruleId ?? "unknown"
      const offset = offsetAt(parsed.source, message.line, message.column)
      const matching = parsed.analysis.occurrences.find((occurrence) => {
        const node = occurrence.node as { readonly range?: ReadonlyArray<number> }
        return occurrence.messageId === message.messageId
          && node.range !== undefined
          && (node.range[0] ?? -1) <= offset
          && (node.range[1] ?? -1) >= offset
      })
      const identity = parsed.analysis.identityAtOffset(
        offset,
        matching?.identity.construct ?? `diagnostic:${rule}`
      )
      const excerpt = lineExcerpt(parsed.source, message.line)
      return new AuditFinding({
        engine: "eslint",
        file,
        rule,
        declaration: identity.declaration,
        construct: identity.construct,
        occurrence: identity.occurrence,
        severity: message.severity === 2 ? "error" : "message",
        line: message.line,
        ...(excerpt === undefined ? {} : { excerpt })
      })
    })
    const normalized = deduplicateAndSort([...languageFindings, ...eslintFindings])
    const findings = normalized.filter((finding) => finding.severity === "error")
    const messages = normalized.filter((finding) => finding.severity === "message")
    yield* Effect.logInfo(`Effect audit found ${findings.length} blocking findings and ${messages.length} advisory messages`)

    const baselineFile = path.join(options.root, "effect-audit-baseline.json")
    const exists = yield* fs.exists(baselineFile).pipe(
      Effect.mapError((error) => auditError("invalid-output", String(error)))
    )
    if (!exists) {
      return yield* Effect.fail(auditError("baseline-missing", "effect-audit-baseline.json does not exist"))
    }

    const baseline = yield* fs.readFileString(baselineFile).pipe(
      Effect.mapError((error) => auditError("invalid-output", String(error))),
      Effect.flatMap((contents) => decodeJson(AuditBaselineJson, contents, "baseline")),
      Effect.flatMap(validateBaseline)
    )
    const comparison = compareAudit(baseline, findings)
    if (comparison.added.length > 0) {
      return yield* Effect.fail(auditError(
        options.mode === "update" ? "baseline-growth" : "new-findings",
        `${comparison.added.length} finding identities were added`,
        comparison.added
      ))
    }
    if (options.mode === "check" && comparison.removed.length > 0) {
      return yield* Effect.fail(auditError(
        "stale-baseline",
        `${comparison.removed.length} baseline identities are stale`,
        comparison.removed
      ))
    }
    if (options.mode === "update") {
      const encoded = yield* Schema.encodeEffect(AuditBaselineJson)(findings).pipe(
        Effect.mapError((error) => auditError("invalid-output", String(error)))
      )
      yield* fs.writeFileString(baselineFile, encoded).pipe(
        Effect.mapError((error) => auditError("invalid-output", String(error)))
      )
    }
    return {
      findings,
      messages,
      added: comparison.added,
      removed: comparison.removed,
      updated: options.mode === "update"
    }
  }
)

export const runAudit = Effect.fn("effect-audit.run")(
  function* (options: { readonly root: string; readonly mode: "check" | "update" }) {
    const runner = yield* AuditCommandRunner
    return yield* collectAudit(runner, options)
  }
)

const auditCommand = Command.make("effect-audit", {
  update: Flag.boolean("update")
}, ({ update }) => Effect.gen(function*() {
  const path = yield* Path.Path
  const root = yield* path.fromFileUrl(new URL("../", import.meta.url))
  yield* runAudit({ root, mode: update ? "update" : "check" })
}))

const program = Command.run(auditCommand, { version: "0.0.0" }).pipe(
  Effect.provide(AuditCommandRunnerLive),
  Effect.provide(NodeServices.layer)
)

if (import.meta.main) {
  NodeRuntime.runMain(program)
}
