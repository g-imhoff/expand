import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { clearCaches } from "@typescript-eslint/parser"
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
import {
  GrepCandidate,
  GrepInventoryJson,
  compareGrepInventory,
  grepCandidateCounts,
  grepCandidateKey,
  prepareGrepInventoryUpdate,
  validateGrepInventory
} from "./effect-inventory-model"
import { NonNegativeInt, PositiveInt, type HostBoundary } from "./effect-policy-model"

export interface AuditCommandRequest {
  readonly name:
    | "language-service"
    | "eslint"
    | "typescript-files"
    | "tracked-files"
    | "tracked-modes"
    | "grep-json"
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

const RipgrepEnvelopeJson = Schema.fromJsonString(Schema.Struct({
  type: Schema.String,
  data: Schema.Unknown
}))

const RipgrepMatchData = Schema.Struct({
  path: Schema.Struct({ text: Schema.String }),
  lines: Schema.Struct({ text: Schema.String }),
  line_number: PositiveInt,
  absolute_offset: NonNegativeInt,
  submatches: Schema.Array(Schema.Struct({
    match: Schema.Struct({ text: Schema.String }),
    start: NonNegativeInt,
    end: NonNegativeInt
  }))
})

const typeScriptFile = /\.(?:ts|tsx|mts|cts)$/u
const sourceFile = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u
const broadText = /[*?[\]{}]/u
const grepPattern = "\\basync\\b|\\bawait\\b|new\\s+Promise\\b|\\bPromise(?:Like)?\\s*<|\\bPromise\\.(?:all|allSettled|any|race|resolve|reject)\\b|\\.(?:then|catch|finally)\\s*\\(|\\b(?:setTimeout|setInterval|setImmediate|queueMicrotask|fetch)\\s*\\(|new\\s+(?:Date|WebSocket|Worker|MessageChannel|BroadcastChannel)\\s*\\(|\\b(?:console\\.\\w+|Date\\.now|performance\\.now|Math\\.random|crypto\\.randomUUID|JSON\\.(?:parse|stringify)|process\\.[A-Za-z_$][A-Za-z0-9_$]*|(?:window|document|navigator|localStorage|sessionStorage)\\.)|\\bnode:[^'\"[:space:]]+|\\b[A-Za-z_$][A-Za-z0-9_$]*\\.run(?:Promise(?:Exit)?|Sync(?:Exit)?|Fork|Callback|Main)\\b"
const grepGlobArgs = [
  "-g",
  "*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
  "-g",
  "!.git/**",
  "-g",
  "!**/node_modules/**",
  "-g",
  "!**/{dist,out,build,coverage,test-results,playwright-report}/**"
] as const
const ripgrepEventTypes = new Set(["begin", "match", "context", "end", "summary"])
const generatedPathSegments = new Set([
  ".git",
  "node_modules",
  "dist",
  "out",
  "build",
  "coverage",
  "test-results",
  "playwright-report"
])

export const utf8ByteOffsetToCodeUnit = (text: string, byteOffset: number): number | undefined => {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) return undefined
  let bytes = 0
  for (let index = 0; index < text.length;) {
    if (bytes === byteOffset) return index
    const point = text.codePointAt(index) ?? 0xfffd
    const width = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
    if (byteOffset < bytes + width) return undefined
    bytes += width
    index += point > 0xffff ? 2 : 1
  }
  return bytes === byteOffset ? text.length : undefined
}

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
}, {
  name: "grep-json",
  command: "rg",
  args: ["-n", "--json", "--hidden", ...grepGlobArgs, grepPattern, "."],
  cwd: root,
  acceptedExitCodes: [0, 1]
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

type RipgrepMatch = Schema.Schema.Type<typeof RipgrepMatchData>

const decodeRipgrepOutput = Effect.fn("effect-audit.decodeRipgrep")(
  function*(result: AuditCommandResult) {
    if (result.stdout.trim().length === 0) {
      return yield* Effect.fail(auditError("invalid-output", "grep-json returned empty JSON"))
    }
    const lines = result.stdout.split("\n")
    if (lines.at(-1) === "") lines.pop()
    if (lines.length === 0 || lines.some((line) => line.trim().length === 0)) {
      return yield* Effect.fail(auditError("invalid-output", "grep-json returned invalid NDJSON framing"))
    }
    const matches: Array<RipgrepMatch> = []
    let summaries = 0
    for (const [index, line] of lines.entries()) {
      const envelope = yield* Schema.decodeUnknownEffect(RipgrepEnvelopeJson)(line).pipe(
        Effect.mapError((cause) => auditError(
          "invalid-output",
          `grep-json returned invalid JSON line ${index + 1}: ${String(cause)}`
        ))
      )
      if (!ripgrepEventTypes.has(envelope.type)) {
        return yield* Effect.fail(auditError("invalid-output", `grep-json returned unknown event ${envelope.type}`))
      }
      if (envelope.type === "summary") {
        summaries += 1
        if (index !== lines.length - 1) {
          return yield* Effect.fail(auditError("invalid-output", "grep-json summary was not final"))
        }
      }
      if (envelope.type !== "match") continue
      const match = yield* Schema.decodeUnknownEffect(RipgrepMatchData)(envelope.data).pipe(
        Effect.mapError((cause) => auditError(
          "invalid-output",
          `grep-json returned an invalid match: ${String(cause)}`
        ))
      )
      if (match.submatches.length === 0) {
        return yield* Effect.fail(auditError("invalid-output", "grep-json returned a match without submatches"))
      }
      let priorEnd = 0
      for (const submatch of match.submatches) {
        const start = utf8ByteOffsetToCodeUnit(match.lines.text, submatch.start)
        const end = utf8ByteOffsetToCodeUnit(match.lines.text, submatch.end)
        if (submatch.match.text.length === 0
          || start === undefined
          || end === undefined
          || submatch.start > submatch.end
          || submatch.start < priorEnd
          || match.lines.text.slice(start, end) !== submatch.match.text) {
          return yield* Effect.fail(auditError("invalid-output", "grep-json returned invalid submatch offsets"))
        }
        priorEnd = submatch.end
      }
      matches.push(match)
    }
    if (summaries !== 1) {
      return yield* Effect.fail(auditError("invalid-output", "grep-json must return one final summary"))
    }
    if ((result.exitCode === 1) !== (matches.length === 0)) {
      return yield* Effect.fail(auditError("invalid-output", "grep-json exit status disagrees with match output"))
    }
    return matches
  }
)

const normalizeRepositoryPath = (root: string, file: string, path: Path.Path) => {
  const absolute = path.isAbsolute(file) ? file : path.resolve(root, file)
  const relative = path.relative(root, absolute)
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined
  return relative.split(path.sep).join("/").replace(/^\.\//u, "")
}

const inScopeGrepSource = (file: string) => sourceFile.test(file)
  && !file.split("/").some((segment) => generatedPathSegments.has(segment))

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
  const regularFiles: Array<string> = []
  for (const entry of output.split("\0")) {
    if (entry.length === 0) continue
    const separator = entry.indexOf("\t")
    if (separator < 0) return undefined
    const header = entry.slice(0, separator).match(/^([0-7]+) [0-9a-f]+ ([0-3])$/u)
    if (header === null) return undefined
    if (header[2] === "0") {
      const file = entry.slice(separator + 1)
      files.push(file)
      if (header[1]?.startsWith("100") === true) regularFiles.push(file)
    }
  }
  return { files, regularFiles }
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
              ecmaFeatures: { jsx: true },
              project: typed ? path.join(root, "tsconfig.effect-audit.json") : false,
              projectService: false,
              tsconfigRootDir: root
            },
            sourceType: file.endsWith(".cjs") ? "commonjs" : "module"
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

type BoundaryOccurrence = ReturnType<typeof analyzeEffectBoundaryProgram>["occurrences"][number]

interface GrepCandidateEvidence {
  readonly candidate: GrepCandidate
  readonly messageId?: BoundaryOccurrence["messageId"]
  readonly auditFixture: boolean
  readonly stringLike: boolean
  readonly lexical: boolean
}

interface RawGrepCandidate {
  readonly file: string
  readonly declaration: string
  readonly construct: string
  readonly semanticOccurrence?: number
  readonly messageId?: BoundaryOccurrence["messageId"]
  readonly line: number
  readonly excerpt: string
  readonly sourceStart: number
  readonly sourceEnd: number
  readonly matchedText: string
  readonly auditFixture: boolean
  readonly stringLike: boolean
}

const objectRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined

const calleeName = (value: unknown): string | undefined => {
  const node = objectRecord(value)
  if (node?.type === "Identifier" && typeof node.name === "string") return node.name
  if (node?.type !== "MemberExpression") return undefined
  const property = objectRecord(node.property)
  return property?.type === "Identifier" && typeof property.name === "string" ? property.name : undefined
}

const sourceTextEvidence = (sourceCode: SourceCode, offset: number) => {
  let node: unknown = sourceCode.getNodeByRangeIndex(offset)
  let stringLike = false
  for (let depth = 0; depth < 64; depth += 1) {
    const record = objectRecord(node)
    if (record === undefined) break
    if ((record.type === "Literal" && typeof record.value === "string")
      || record.type === "TemplateElement"
      || record.type === "JSXText") {
      stringLike = true
    }
    if (stringLike
      && record.type === "CallExpression"
      && ["invalidCase", "validCase", "verify"].includes(calleeName(record.callee) ?? "")) {
      return { stringLike, auditFixture: true }
    }
    node = record.parent
  }
  return { stringLike, auditFixture: false }
}

const nativePromiseStaticToken = /^Promise\.(all|allSettled|any|race|resolve|reject)$/u
const promiseTypeToken = /^(Promise|PromiseLike)\s*</u
const promiseChainToken = /^\.(then|catch|finally)\s*\($/u
const platformFunctionToken = /^(setTimeout|setInterval|setImmediate|queueMicrotask|fetch)\s*\($/u
const platformConstructorToken = /^new\s+(Date|WebSocket|Worker|MessageChannel|BroadcastChannel)\s*\($/u
const platformExactMemberToken = /^(console\.\w+|Date\.now|performance\.now|Math\.random|crypto\.randomUUID|JSON\.(?:parse|stringify)|process\.[A-Za-z_$][A-Za-z0-9_$]*)$/u
const platformObjectToken = /^(window|document|navigator|localStorage|sessionStorage)\.$/u
const nodeImportToken = /^node:[^'"\s]+$/u
const runnerToken = /^[A-Za-z_$][A-Za-z0-9_$]*\.run(?:Promise(?:Exit)?|Sync(?:Exit)?|Fork|Callback|Main)$/u

const compatibleGrepOccurrence = (matchedText: string, occurrence: BoundaryOccurrence) => {
  const construct = occurrence.identity.construct
  if (matchedText === "async") {
    return occurrence.messageId === "nativeAsync" && construct === "native:async"
  }
  if (matchedText === "await") {
    return occurrence.messageId === "nativeAwait" && construct === "native:await"
  }
  if (/^new\s+Promise$/u.test(matchedText)) {
    return occurrence.messageId === "nativePromise" && construct === "promise:new"
  }
  const promiseStatic = matchedText.match(nativePromiseStaticToken)?.[1]
  if (promiseStatic !== undefined) {
    return occurrence.messageId === "nativePromise" && construct === `promise:Promise.${promiseStatic}`
  }
  const promiseType = matchedText.match(promiseTypeToken)?.[1]
  if (promiseType !== undefined) {
    return occurrence.messageId === "promiseSignature" && construct === `promise-type:${promiseType}`
  }
  const promiseChain = matchedText.match(promiseChainToken)?.[1]
  if (promiseChain !== undefined) {
    return occurrence.messageId === "promiseChain" && construct === `promise-chain:${promiseChain}`
  }
  const platformFunction = matchedText.match(platformFunctionToken)?.[1]
  if (platformFunction !== undefined) {
    return occurrence.messageId === "platformEffect" && construct === `platform:${platformFunction}`
  }
  const platformConstructor = matchedText.match(platformConstructorToken)?.[1]
  if (platformConstructor !== undefined) {
    return occurrence.messageId === "platformEffect" && construct === `platform:new:${platformConstructor}`
  }
  if (platformExactMemberToken.test(matchedText)) {
    return occurrence.messageId === "platformEffect" && construct === `platform:${matchedText}`
  }
  const platformObject = matchedText.match(platformObjectToken)?.[1]
  if (platformObject !== undefined) {
    return occurrence.messageId === "platformEffect" && construct.startsWith(`platform:${platformObject}.`)
  }
  if (nodeImportToken.test(matchedText)) {
    return occurrence.messageId === "platformEffect" && construct === `platform:import:${matchedText}`
  }
  if (runnerToken.test(matchedText)) {
    return occurrence.messageId === "runnerOutsideBoundary" && construct === `runner:${matchedText}`
  }
  return false
}

const compatibleOccurrenceAt = (
  analysis: ReturnType<typeof analyzeEffectBoundaryProgram>,
  matchedText: string,
  sourceStart: number,
  sourceEnd: number
): { readonly occurrence?: BoundaryOccurrence; readonly ambiguous: boolean } => {
  const compatible = analysis.occurrences.flatMap((occurrence) => {
    const range = objectRecord(occurrence.node)?.range
    if (!Array.isArray(range)
      || typeof range[0] !== "number"
      || typeof range[1] !== "number"
      || range[0] > sourceStart
      || sourceEnd > range[1]
      || !compatibleGrepOccurrence(matchedText, occurrence)) {
      return []
    }
    return [{ occurrence, size: range[1] - range[0] }]
  }).sort((left, right) => left.size - right.size)
  const first = compatible[0]
  if (first === undefined) return { ambiguous: false }
  return {
    occurrence: first.occurrence,
    ambiguous: compatible[1]?.size === first.size
  }
}

const collectGrepCandidates = Effect.fn("effect-audit.collectGrepCandidates")(
  function*(input: {
    readonly root: string
    readonly matches: ReadonlyArray<RipgrepMatch>
    readonly indexed: ReadonlySet<string>
    readonly cache: Map<string, ParsedSource>
  }) {
    const path = yield* Path.Path
    const aliases = new Map<string, string>()
    const raw: Array<RawGrepCandidate> = []
    for (const match of input.matches) {
      if (match.path.text.trim().length === 0) {
        return yield* Effect.fail(auditError("invalid-output", "grep-json returned an empty path"))
      }
      const file = normalizeRepositoryPath(input.root, match.path.text, path)
      if (file === undefined || !input.indexed.has(file) || !inScopeGrepSource(file)) continue
      const previousAlias = aliases.get(file)
      if (previousAlias !== undefined && previousAlias !== match.path.text) {
        return yield* Effect.fail(auditError("invalid-output", `grep-json returned duplicate path aliases for ${file}`))
      }
      aliases.set(file, match.path.text)
      const parsed = yield* loadParsedSource(input.root, file, typeScriptFile.test(file), input.cache)
      const lineStart = utf8ByteOffsetToCodeUnit(parsed.sourceCode.text, match.absolute_offset)
      if (lineStart === undefined) {
        return yield* Effect.fail(auditError("invalid-output", `grep-json returned invalid absolute offset for ${file}`))
      }
      const expectedLineStart = yield* Effect.try({
        try: () => parsed.sourceCode.getIndexFromLoc({ line: match.line_number, column: 0 }),
        catch: (cause) => auditError("invalid-output", `grep-json returned invalid line for ${file}: ${String(cause)}`)
      })
      if (lineStart !== expectedLineStart
        || parsed.sourceCode.text.slice(lineStart, lineStart + match.lines.text.length) !== match.lines.text) {
        return yield* Effect.fail(auditError("invalid-output", `grep-json line text disagrees with ${file}`))
      }
      for (const submatch of match.submatches) {
        const absoluteStart = match.absolute_offset + submatch.start
        const absoluteEnd = match.absolute_offset + submatch.end
        if (!Number.isSafeInteger(absoluteStart) || !Number.isSafeInteger(absoluteEnd)) {
          return yield* Effect.fail(auditError("invalid-output", `grep-json offset overflow for ${file}`))
        }
        const sourceStart = utf8ByteOffsetToCodeUnit(parsed.sourceCode.text, absoluteStart)
        const sourceEnd = utf8ByteOffsetToCodeUnit(parsed.sourceCode.text, absoluteEnd)
        const relativeStart = utf8ByteOffsetToCodeUnit(match.lines.text, submatch.start)
        const relativeEnd = utf8ByteOffsetToCodeUnit(match.lines.text, submatch.end)
        if (sourceStart === undefined
          || sourceEnd === undefined
          || relativeStart === undefined
          || relativeEnd === undefined
          || sourceStart !== lineStart + relativeStart
          || sourceEnd !== lineStart + relativeEnd
          || parsed.sourceCode.text.slice(sourceStart, sourceEnd) !== submatch.match.text) {
          return yield* Effect.fail(auditError("invalid-output", `grep-json source offsets disagree with ${file}`))
        }
        const lexicalConstruct = `lexical:${submatch.match.text}`
        const selection = compatibleOccurrenceAt(
          parsed.analysis,
          submatch.match.text,
          sourceStart,
          sourceEnd
        )
        if (selection.ambiguous) {
          return yield* Effect.fail(auditError("invalid-output", `grep-json semantic identity has an equal-range ambiguity for ${file}`))
        }
        const identity = selection.occurrence?.identity
          ?? parsed.analysis.fallbackIdentityAtOffset(sourceStart, lexicalConstruct)
        const semantic = selection.occurrence !== undefined
        const textEvidence = sourceTextEvidence(parsed.sourceCode, sourceStart)
        raw.push({
          file,
          declaration: identity.declaration,
          construct: semantic ? identity.construct : lexicalConstruct,
          ...(semantic ? { semanticOccurrence: identity.occurrence } : {}),
          ...(selection.occurrence === undefined ? {} : { messageId: selection.occurrence.messageId }),
          line: match.line_number,
          excerpt: parsed.sourceCode.lines[match.line_number - 1] ?? "",
          sourceStart,
          sourceEnd,
          matchedText: submatch.match.text,
          auditFixture: textEvidence.auditFixture,
          stringLike: textEvidence.stringLike
        })
      }
    }
    raw.sort((left, right) => left.file.localeCompare(right.file)
      || left.sourceStart - right.sourceStart
      || left.sourceEnd - right.sourceEnd
      || left.matchedText.localeCompare(right.matchedText))
    const lexicalCounts = new Map<string, number>()
    const evidence = new Map<string, GrepCandidateEvidence>()
    for (const detection of raw) {
      const lexicalKey = [detection.file, detection.declaration, detection.construct].join("\u0000")
      const occurrence = detection.semanticOccurrence ?? lexicalCounts.get(lexicalKey) ?? 0
      if (detection.semanticOccurrence === undefined) lexicalCounts.set(lexicalKey, occurrence + 1)
      const candidate = new GrepCandidate({
        file: detection.file,
        declaration: detection.declaration,
        construct: detection.construct,
        occurrence,
        classification: "migration-debt",
        rationale: "",
        line: detection.line,
        excerpt: detection.excerpt
      })
      const key = grepCandidateKey(candidate)
      if (evidence.has(key)) {
        return yield* Effect.fail(auditError("invalid-output", `grep-json produced duplicate candidate ${key}`))
      }
      evidence.set(key, {
        candidate,
        ...(detection.messageId === undefined ? {} : { messageId: detection.messageId }),
        auditFixture: detection.auditFixture,
        stringLike: detection.stringLike,
        lexical: detection.semanticOccurrence === undefined
      })
    }
    const candidates = [...evidence.values()]
      .map((item) => item.candidate)
      .sort((left, right) => grepCandidateKey(left).localeCompare(grepCandidateKey(right)))
    return { candidates, evidence }
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
      const canonicalFile = typeof boundary.file === "string"
        ? normalizeRepositoryPath(input.root, boundary.file, path)
        : undefined
      if (!exactFile(boundary.file)
        || canonicalFile !== boundary.file
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

const validateGrepClassifications = Effect.fn("effect-audit.validateGrepClassifications")(
  function*(inventory: ReadonlyArray<GrepCandidate>, evidence: ReadonlyMap<string, GrepCandidateEvidence>) {
    const permanentBoundaryCounts = new Map<string, number>()
    for (const boundary of effectHostBoundaries) {
      const key = boundaryKey(boundary)
      permanentBoundaryCounts.set(key, (permanentBoundaryCounts.get(key) ?? 0) + 1)
    }
    for (const candidate of inventory) {
      if (candidate.classification === "migration-debt") continue
      const key = grepCandidateKey(candidate)
      const proof = evidence.get(key)
      if (proof === undefined) {
        return yield* Effect.fail(auditError(
          "invalid-output",
          `${candidate.classification} candidate has no current analyzer evidence: ${key}`
        ))
      }
      const valid = candidate.classification === "host-boundary"
        ? permanentBoundaryCounts.get(key) === 1
        : candidate.classification === "host-required-type"
          ? proof.messageId === "promiseSignature"
            && (candidate.construct.startsWith("promise-type:")
              || candidate.construct.startsWith("promise-like:"))
          : candidate.classification === "audit-fixture"
            ? proof.lexical && proof.auditFixture
            : proof.lexical && !proof.auditFixture && !proof.stringLike
      if (!valid) {
        return yield* Effect.fail(auditError(
          "invalid-output",
          `${candidate.classification} candidate lacks matching analyzer evidence: ${key}`
        ))
      }
    }
  }
)

const readGrepInventory = Effect.fn("effect-audit.readGrepInventory")(
  function*(root: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const file = path.join(root, "effect-grep-inventory.json")
    const exists = yield* fs.exists(file).pipe(
      Effect.mapError((cause) => auditError("invalid-output", `cannot inspect grep inventory: ${String(cause)}`))
    )
    if (!exists) {
      return yield* Effect.fail(auditError("baseline-missing", "effect-grep-inventory.json is missing"))
    }
    const text = yield* fs.readFileString(file).pipe(
      Effect.mapError((cause) => auditError("invalid-output", `cannot read grep inventory: ${String(cause)}`))
    )
    const inventory = yield* decodeRequiredJson("grep inventory", GrepInventoryJson, text)
    const invalid = validateGrepInventory(inventory)
    if (invalid !== undefined) return yield* Effect.fail(auditError("invalid-output", invalid))
    return inventory
  }
)

const writeGrepInventory = Effect.fn("effect-audit.writeGrepInventory")(
  function*(root: string, inventory: ReadonlyArray<GrepCandidate>) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const encoded = yield* Schema.encodeEffect(GrepInventoryJson)([...inventory]).pipe(
      Effect.mapError((cause) => auditError("invalid-output", `cannot encode grep inventory: ${String(cause)}`))
    )
    yield* fs.writeFileString(path.join(root, "effect-grep-inventory.json"), `${encoded}\n`).pipe(
      Effect.mapError((cause) => auditError("invalid-output", `cannot write grep inventory: ${String(cause)}`))
    )
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
    const modeManifest = parseIndexModes(modeOutput)
    if (trackedOutput.length === 0 || modeOutput.length === 0 || modeManifest === undefined) {
      return yield* Effect.fail(auditError("invalid-output", "git returned an invalid index manifest"))
    }
    const modeFiles = modeManifest.files
    const trackedFiles = trackedOutput.split("\0").filter((file) => file.length > 0)
    const trackedCounts = normalizedCounts(options.root, trackedFiles, path)
    const modeCounts = normalizedCounts(options.root, modeFiles, path)
    if (trackedCounts.size !== modeCounts.size
      || [...trackedCounts].some(([file, count]) => count !== 1 || modeCounts.get(file) !== 1)) {
      return yield* Effect.fail(auditError("invalid-output", "git index manifests disagree"))
    }
    const indexed = new Set(modeCounts.keys())
    const regularCounts = normalizedCounts(options.root, modeManifest.regularFiles, path)
    const grepIndexed = new Set([...regularCounts]
      .filter(([, count]) => count === 1)
      .map(([file]) => file))
    const indexedTypeScript = [...indexed].filter((file) => typeScriptFile.test(file)).sort()
    const indexedSources = [...indexed].filter((file) => sourceFile.test(file)).sort()

    const typeScriptOutput = responses.get("typescript-files")?.stdout ?? ""
    if (typeScriptOutput.trim().length === 0) {
      return yield* Effect.fail(auditError("invalid-output", "typescript-files returned an empty file list"))
    }
    const resolvedTypeScript = new Set(typeScriptOutput
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
    const grepMatches = yield* decodeRipgrepOutput(responses.get("grep-json") ?? {
      exitCode: 1,
      stdout: "",
      stderr: ""
    })
    const grep = yield* collectGrepCandidates({
      root: options.root,
      matches: grepMatches,
      indexed: grepIndexed,
      cache
    })
    const baseline = yield* readBaseline(options.root)
    const comparison = compareAudit(baseline, blocking)
    const inventory = yield* readGrepInventory(options.root)
    const grepComparison = compareGrepInventory(inventory, grep.candidates)

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
    if (grepComparison.added.length > 0) {
      return yield* Effect.fail(auditError(
        options.mode === "update" ? "baseline-growth" : "new-findings",
        `${grepComparison.added.length} new grep candidate keys`
      ))
    }
    if (options.mode === "check" && grepComparison.removed.length > 0) {
      return yield* Effect.fail(auditError(
        "stale-baseline",
        `${grepComparison.removed.length} stale grep inventory keys`
      ))
    }

    const updatedInventory = options.mode === "update"
      ? prepareGrepInventoryUpdate(inventory, grep.candidates)
      : { inventory, added: [], protectedRemoved: [] }
    if (updatedInventory.added.length > 0) {
      return yield* Effect.fail(auditError(
        "baseline-growth",
        `${updatedInventory.added.length} new grep candidate keys`
      ))
    }
    if (updatedInventory.protectedRemoved.length > 0) {
      return yield* Effect.fail(auditError(
        "stale-baseline",
        `${updatedInventory.protectedRemoved.length} reviewed grep candidates no longer resolve`
      ))
    }
    yield* validateGrepClassifications(updatedInventory.inventory, grep.evidence)
    if (options.mode === "update") {
      yield* writeBaseline(options.root, blocking)
      yield* writeGrepInventory(options.root, updatedInventory.inventory)
    }

    return {
      blocking,
      advisory,
      candidateCounts: grepCandidateCounts(updatedInventory.inventory)
    }
  }
)

export const runAudit = Effect.fn("effect-audit.run")(
  function* (options: { readonly root: string; readonly mode: "check" | "update" }) {
    const runner = yield* AuditCommandRunner
    return yield* collectAudit(runner, options).pipe(
      Effect.ensuring(Effect.sync(clearCaches))
    )
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
  yield* Effect.logInfo([
    `Effect audit: ${result.blocking.length} errors, ${result.advisory.length} messages`,
    ...Object.entries(result.candidateCounts).map(([classification, count]) => `${classification}=${count}`)
  ].join(", "))
}))

const program = Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(AuditCommandRunnerLive),
  Effect.provide(NodeServices.layer)
)

if (import.meta.main) NodeRuntime.runMain(program)
