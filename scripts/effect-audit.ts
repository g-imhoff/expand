import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Context, Effect, FileSystem, Layer, Path, Schema, Stdio, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import tseslint from "typescript-eslint"
import { analyzeEffectBoundaryProgram } from "../eslint-rules/effect-boundary-analysis.mjs"
import { effectHostBoundaries } from "../eslint-rules/effect-host-boundaries.mjs"
import { AuditFinding, EffectAuditError } from "./effect-audit-model"
import {
  CandidateInventoryJson,
  EFFECT_CANDIDATE_ARGS,
  collectCandidateGrep,
  validateCandidateRecords
} from "./effect-candidate-inventory"
import { ExecutableInventoryError, validateExecutableInventory } from "./effect-executable-inventory"
import { HostBoundary, NonNegativeInt, PositiveInt } from "./effect-policy-model"

export interface AuditCommandRequest {
  readonly name: "language-service" | "eslint" | "typescript-files" | "tracked-files" | "grep-json"
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
interface SourceNode {
  readonly type: string
  readonly range?: ReadonlyArray<number>
  readonly value?: unknown
  readonly [key: string]: unknown
}

interface ParsedSource {
  readonly source: string
  readonly analysis: ReturnType<typeof analyzeEffectBoundaryProgram>
  readonly ast: unknown
  readonly visitorKeys?: unknown
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
    return {
      source,
      analysis,
      ast: parsed.ast,
      ...(parsed.visitorKeys === undefined ? {} : { visitorKeys: parsed.visitorKeys })
    } satisfies ParsedSource
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

const isSourceNode = (value: unknown): value is SourceNode =>
  typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"

const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0

const sortAuditFindings = (findings: ReadonlyArray<AuditFinding>): ReadonlyArray<AuditFinding> =>
  [...findings].sort((left, right) =>
    compareText(left.engine, right.engine)
    || compareText(left.file, right.file)
    || compareText(left.rule, right.rule)
    || compareText(left.declaration, right.declaration)
    || compareText(left.construct, right.construct)
    || left.occurrence - right.occurrence
  )

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
        return yield* auditError("invalid-boundary", `malformed boundary: ${key}`)
      }
      if (trackedCounts.get(boundary.file) !== 1) {
        return yield* auditError("invalid-boundary", `boundary file is not exactly tracked once: ${boundary.file}`)
      }
      if (eslintCounts.get(boundary.file) !== 1) {
        return yield* auditError("invalid-boundary", `boundary file has no unique ESLint consumer: ${boundary.file}`)
      }
      if (identityCounts.get(key) !== 1) {
        return yield* auditError("invalid-boundary", `boundary identity is duplicated: ${key}`)
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
        return yield* auditError("invalid-boundary", `boundary is unconsumed or ambiguous: ${boundaryIdentityKey(boundary)}`)
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
    name: "grep-json",
    command: "rg",
    args: ["--json", ...EFFECT_CANDIDATE_ARGS],
    cwd: root,
    acceptedExitCodes: [0, 1]
  }
]

const runCommand = Effect.fn("effect-audit.run-command")(
  function*(runner: AuditCommandRunner["Service"], request: AuditCommandRequest) {
    const result = yield* runner.run(request)
    if (!request.acceptedExitCodes.includes(result.exitCode)) {
      return yield* auditError(
        "command-failed",
        `${request.name} exited with ${result.exitCode}${result.stderr.length > 0 ? `: ${result.stderr}` : ""}`
      )
    }
    if (result.stdout.length === 0) {
      return yield* auditError("invalid-output", `${request.name} produced empty stdout`)
    }
    return result
  }
)

const decodeJson = <A, I>(schema: Schema.Codec<A, I>, input: unknown, command: string) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError((error) => auditError("invalid-output", `${command}: ${String(error)}`))
  )

const occurrenceRange = (occurrence: { readonly node: unknown }) => {
  if (!isSourceNode(occurrence.node)) return undefined
  const [start, end] = occurrence.node.range ?? []
  return start === undefined || end === undefined ? undefined : { start, end }
}

export const isRegisteredNodeBuiltinDiagnostic = (options: {
  readonly file: string
  readonly diagnostic: {
    readonly name: string
    readonly start: number
    readonly length?: number | undefined
  }
  readonly occurrences: ReadonlyArray<{
    readonly identity: {
      readonly file: string
      readonly declaration: string
      readonly construct: string
      readonly occurrence: number
    }
    readonly node: unknown
  }>
  readonly boundaries: ReadonlyArray<{
    readonly file: string
    readonly declaration: string
    readonly construct: string
    readonly occurrence: number
  }>
}): boolean => {
  if (options.diagnostic.name !== "nodeBuiltinImport") return false
  const length = options.diagnostic.length
  if (length === undefined || length <= 0) return false
  const end = options.diagnostic.start + length
  if (!Number.isSafeInteger(end)) return false
  const occurrences = options.occurrences.filter((occurrence) => {
    const range = occurrenceRange(occurrence)
    return occurrence.identity.file === options.file
      && occurrence.identity.construct.startsWith("platform:import:node:")
      && range !== undefined
      && range.start <= options.diagnostic.start
      && range.end >= end
  })
  if (occurrences.length !== 1) return false
  const identity = occurrences[0]!.identity
  return options.boundaries.filter((boundary) =>
    boundary.file === identity.file
    && boundary.declaration === identity.declaration
    && boundary.construct === identity.construct
    && boundary.occurrence === identity.occurrence
  ).length === 1
}

const collectAudit = Effect.fn("effect-audit.collect")(
  function*(runner: AuditCommandRunner["Service"], root: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const results = new Map<AuditCommandRequest["name"], AuditCommandResult>()
    for (const request of commandRequests(root)) {
      results.set(request.name, yield* runCommand(runner, request))
    }
    const output = (name: AuditCommandRequest["name"]) => results.get(name)?.stdout ?? ""

    const tracked = output("tracked-files").split("\0").filter(Boolean)
    if (new Set(tracked).size !== tracked.length) {
      return yield* auditError("invalid-output", "tracked manifest contains duplicate paths")
    }
    const trackedSet = new Set(tracked)
    const languageService = yield* decodeJson(LanguageServiceJson, output("language-service"), "language-service")
    const eslint = yield* decodeJson(EslintJson, output("eslint"), "eslint")

    const typeScriptFiles = new Set(
      output("typescript-files").split(/\r?\n/)
        .map((file) => normalizeFile(path, root, file))
        .filter((file): file is string => file !== undefined)
    )
    const eslintFiles = eslint
      .map((result) => normalizeFile(path, root, result.filePath))
      .filter((file): file is string => file !== undefined)
    const eslintFileSet = new Set(eslintFiles)
    const missingTypeScript = tracked.filter((file) => isTypeScriptFile(file) && !typeScriptFiles.has(file))
    const missingEslint = tracked.filter((file) => isEslintFile(file) && !eslintFileSet.has(file))
    if (missingTypeScript.length > 0 || missingEslint.length > 0) {
      return yield* auditError(
        "coverage-gap",
        [...missingTypeScript.map((file) => `typescript:${file}`), ...missingEslint.map((file) => `eslint:${file}`)].join(", ")
      )
    }

    yield* validateHostBoundaries({
      root,
      trackedFiles: tracked,
      eslintFiles,
      boundaries: effectHostBoundaries
    })

    const candidateObservations = yield* collectCandidateGrep({
      root,
      output: output("grep-json"),
      trackedFiles: trackedSet
    }).pipe(Effect.mapError((error) => auditError("invalid-output", error.detail)))

    const relevantLanguage = languageService.diagnostics.flatMap((diagnostic) => {
      const file = normalizeFile(path, root, diagnostic.file)
      return file !== undefined && trackedSet.has(file) ? [{ file, diagnostic }] : []
    })
    const relevantEslint = eslint.flatMap((result) => {
      const file = normalizeFile(path, root, result.filePath)
      return file !== undefined && trackedSet.has(file)
        ? result.messages.map((message) => ({ file, message }))
        : []
    })
    const sourceFiles = new Set([
      ...relevantLanguage.map(({ file }) => file),
      ...relevantEslint.map(({ file }) => file)
    ])
    const sources = new Map<string, ParsedSource>()
    for (const file of sourceFiles) sources.set(file, yield* parseSource(root, file, "invalid-output"))

    const languageFindings = relevantLanguage.flatMap(({ diagnostic, file }) => {
      const parsed = sources.get(file)!
      if (isRegisteredNodeBuiltinDiagnostic({
        file,
        diagnostic,
        occurrences: parsed.analysis.occurrences,
        boundaries: effectHostBoundaries
      })) return []
      const identity = parsed.analysis.identityAtOffset(diagnostic.start, `diagnostic:${diagnostic.name}`)
      const excerpt = lineExcerpt(parsed.source, diagnostic.line)
      return [new AuditFinding({
        engine: "effect-language-service",
        file,
        rule: diagnostic.name,
        declaration: identity.declaration,
        construct: identity.construct,
        occurrence: identity.occurrence,
        severity: diagnostic.severity,
        line: diagnostic.line,
        ...(excerpt === undefined ? {} : { excerpt })
      })]
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
    const normalized = sortAuditFindings([...languageFindings, ...eslintFindings])
    const findings = normalized.filter((finding) => finding.severity !== "message")
    const warnings = normalized.filter((finding) => finding.engine === "eslint" && finding.severity === "message")
    const languageMessages = normalized.filter((finding) => finding.engine === "effect-language-service" && finding.severity === "message")
    const unknownMessages = languageMessages.filter((finding) => finding.rule !== "effectFnOpportunity")
    if (unknownMessages.length > 0) {
      return yield* auditError(
        "invalid-output",
        `unknown language-service advisory: ${unknownMessages.map((finding) => finding.rule).join(", ")}`,
        unknownMessages
      )
    }
    const messages = languageMessages.filter((finding) => finding.rule === "effectFnOpportunity")
    const blocking = sortAuditFindings([...findings, ...warnings])
    yield* Effect.logInfo(`Effect audit found ${blocking.length} blocking findings and ${messages.length} advisory messages`)
    if (blocking.length > 0) {
      return yield* auditError("blocking-findings", `${blocking.length} errors or warnings were reported`, blocking)
    }

    const candidateInventoryRaw = yield* fs.readFileString(path.join(root, "effect-candidate-inventory.json")).pipe(
      Effect.mapError((error) => auditError("invalid-output", String(error)))
    )
    const candidateInventory = yield* decodeJson(CandidateInventoryJson, candidateInventoryRaw, "candidate inventory")
    const canonicalCandidateInventory = yield* Schema.encodeEffect(CandidateInventoryJson)(candidateInventory).pipe(
      Effect.mapError((error) => auditError("invalid-output", String(error)))
    )
    if (candidateInventoryRaw !== canonicalCandidateInventory) {
      return yield* auditError("invalid-output", "candidate inventory is not in canonical byte form")
    }
    const advisoryCounts = new Map<string, number>()
    const advisories = messages.map((message) => {
      const separator = message.declaration.indexOf(":")
      const declaration = separator < 0
        ? { kind: "unknown", name: message.declaration }
        : { kind: message.declaration.slice(0, separator), name: message.declaration.slice(separator + 1) }
      const excerpt = message.excerpt ?? ""
      const key = [message.file, declaration.kind, declaration.name, excerpt, message.rule].join("\u0000")
      const occurrence = advisoryCounts.get(key) ?? 0
      advisoryCounts.set(key, occurrence + 1)
      return { file: message.file, declaration, rule: "effectFnOpportunity" as const, excerpt, occurrence }
    })
    const validatedCandidates = yield* validateCandidateRecords(
      candidateInventory,
      candidateObservations,
      advisories,
      new Map(),
      effectHostBoundaries
    ).pipe(Effect.mapError((error) => auditError("invalid-output", error.detail)))
    const candidateCounts = Object.fromEntries([
      "host-boundary",
      "host-required-type",
      "audit-fixture",
      "lexical-false-positive"
    ].map((kind) => [kind, validatedCandidates.grep.filter((candidate) => candidate.classification.kind === kind).length]))
    yield* Effect.logInfo(
      `Effect candidate inventory found ${validatedCandidates.grep.length} candidates: ${Object.entries(candidateCounts).map(([classification, count]) => `${classification}=${count}`).join(", ")}`
    )
    return {
      findings,
      messages,
      grepCandidates: validatedCandidates.grep,
      grepAdded: [],
      grepRemoved: [],
      grepCounts: candidateCounts
    }
  }
)

export const runAudit = Effect.fn("effect-audit.run")(
  function* (root: string) {
    const runner = yield* AuditCommandRunner
    return yield* collectAudit(runner, root)
  }
)

const program = Effect.gen(function*() {
  const stdio = yield* Stdio.Stdio
  const args = yield* stdio.args
  if (args.length > 0) {
    return yield* auditError("invalid-output", `effect-audit does not accept arguments: ${args.join(" ")}`)
  }
  const path = yield* Path.Path
  const root = yield* path.fromFileUrl(new URL("../", import.meta.url))
  yield* runAudit(root)
  yield* validateExecutableInventory(root).pipe(
    Effect.mapError((error) => auditError("invalid-output", error instanceof ExecutableInventoryError ? error.detail : String(error)))
  )
}).pipe(
  Effect.provide(AuditCommandRunnerLive),
  Effect.provide(NodeServices.layer)
)

if (import.meta.main) {
  NodeRuntime.runMain(program)
}
