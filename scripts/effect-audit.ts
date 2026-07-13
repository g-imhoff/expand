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
import {
  GrepCandidate,
  GrepInventoryJson,
  compareGrepInventory,
  grepCandidateKey,
  grepInventoryValidationError
} from "./effect-inventory-model"
import { HostBoundary, NonNegativeInt, PositiveInt } from "./effect-policy-model"

export interface AuditCommandRequest {
  readonly name: "language-service" | "eslint" | "typescript-files" | "tracked-files" | "tracked-modes" | "grep-json"
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

export const EFFECT_GREP_PATTERN = String.raw`\basync\b|\bawait\b|new\s+Promise\b|\bPromise(?:Like)?\s*<|\bPromise\.(?:all|allSettled|any|race|resolve|reject)\b|\.(?:then|catch|finally)\s*\(|\b(?:setTimeout|setInterval|setImmediate|queueMicrotask|fetch)\s*\(|new\s+(?:Date|WebSocket|Worker|MessageChannel|BroadcastChannel)\s*\(|\b(?:console\.\w+|Date\.now|performance\.now|Math\.random|crypto\.randomUUID|JSON\.(?:parse|stringify)|process\.[A-Za-z_$][A-Za-z0-9_$]*|(?:window|document|navigator|localStorage|sessionStorage)\.)|\bnode:[^'"[:space:]]+|\b[A-Za-z_$][A-Za-z0-9_$]*\.run(?:Promise(?:Exit)?|Sync(?:Exit)?|Fork|Callback|Main)\b`

export const EFFECT_GREP_ARGS = [
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
  EFFECT_GREP_PATTERN
] as const

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

const RipgrepEventJson = Schema.fromJsonString(Schema.Struct({
  type: Schema.Literals(["begin", "match", "end", "summary"]),
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

export const utf8ByteOffsetToCodeUnit = (input: string, byteOffset: number): number => {
  const bounded = Number.isFinite(byteOffset) ? Math.max(0, byteOffset) : 0
  let bytes = 0
  let codeUnits = 0
  for (const character of input) {
    const point = character.codePointAt(0)
    const width = point === undefined ? 0 : point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
    if (bytes + width > bounded) break
    bytes += width
    codeUnits += character.length
  }
  return codeUnits
}

const utf8ByteBoundaryToCodeUnit = (input: string, byteOffset: number): number | undefined => {
  const codeUnit = utf8ByteOffsetToCodeUnit(input, byteOffset)
  return new TextEncoder().encode(input.slice(0, codeUnit)).length === byteOffset ? codeUnit : undefined
}

interface IndexedSourceLine {
  readonly text: string
  readonly codeUnitOffset: number
  readonly byteOffset: number
  readonly byteLength: number
}

const indexSourceLines = (source: string): ReadonlyArray<IndexedSourceLine> => {
  const lines: Array<IndexedSourceLine> = []
  let codeUnitOffset = 0
  let byteOffset = 0
  for (const terminator of source.matchAll(/\r\n|[\n\r\u2028\u2029]/g)) {
    const end = (terminator.index ?? 0) + terminator[0].length
    const text = source.slice(codeUnitOffset, end)
    const byteLength = new TextEncoder().encode(text).length
    lines.push({ text, codeUnitOffset, byteOffset, byteLength })
    codeUnitOffset = end
    byteOffset += byteLength
  }
  if (codeUnitOffset < source.length) {
    const text = source.slice(codeUnitOffset)
    lines.push({
      text,
      codeUnitOffset,
      byteOffset,
      byteLength: new TextEncoder().encode(text).length
    })
  }
  return lines
}

const isSourceNode = (value: unknown): value is SourceNode =>
  typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"

const nodeAtOffset = (parsed: ParsedSource, offset: number): SourceNode | undefined => {
  if (!isSourceNode(parsed.ast)) return undefined
  const visitorKeys = parsed.visitorKeys as Record<string, ReadonlyArray<string>> | undefined
  const stack: Array<SourceNode> = [parsed.ast]
  let selected: SourceNode | undefined
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined) continue
    const [start, end] = node.range ?? []
    if (start !== undefined && end !== undefined && start <= offset && offset <= end) {
      const [selectedStart, selectedEnd] = selected?.range ?? []
      if (selectedStart === undefined || selectedEnd === undefined || end - start <= selectedEnd - selectedStart) {
        selected = node
      }
    }
    const keys = visitorKeys?.[node.type]
      ?? Object.keys(node).filter((key) => !["parent", "range", "loc", "tokens", "comments"].includes(key))
    for (const key of keys) {
      const value = node[key]
      if (Array.isArray(value)) {
        for (const child of value) if (isSourceNode(child)) stack.push(child)
      } else if (isSourceNode(value)) {
        stack.push(value)
      }
    }
  }
  return selected
}

const isAuditFixturePath = (file: string) =>
  /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[^/]+$/.test(file)

const isStringSyntax = (node: SourceNode | undefined) =>
  node?.type === "TemplateElement"
  || node?.type === "TemplateLiteral"
  || (node?.type === "Literal" && typeof node.value === "string")

const matchingOccurrenceScore = (matchedText: string, construct: string): number => {
  if (matchedText === "async" && construct === "native:async") return 100
  if (matchedText === "await" && construct === "native:await") return 100
  if (/^new\s+Promise\b/.test(matchedText) && construct === "promise:new") return 100
  if (/^Promise(?:Like)?\s*</.test(matchedText) && construct.startsWith("signature:Promise")) return 100
  if (/^Promise\./.test(matchedText) && construct.startsWith("promise:")) return 100
  if (/^\.(?:then|catch|finally)\s*\(/.test(matchedText) && construct.startsWith("promise-chain:")) return 100
  if (/\.run(?:Promise(?:Exit)?|Sync(?:Exit)?|Fork|Callback|Main)$/.test(matchedText) && construct.startsWith("runner:")) return 100
  if (/^node:/.test(matchedText) && construct.startsWith("platform:import:node:")) return 100
  if (/^(?:setTimeout|setInterval|setImmediate|queueMicrotask|fetch)\s*\(/.test(matchedText) && construct.startsWith("platform:")) return 100
  if (/^new\s+(?:Date|WebSocket|Worker|MessageChannel|BroadcastChannel)\s*\(/.test(matchedText) && construct.startsWith("platform:")) return 100
  if (/^(?:console\.|Date\.now|performance\.now|Math\.random|crypto\.randomUUID|process\.|window\.|document\.|navigator\.|localStorage\.|sessionStorage\.)/.test(matchedText) && construct.startsWith("platform:")) return 100
  return -1
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
  },
  {
    name: "grep-json",
    command: "rg",
    args: ["--json", ...EFFECT_GREP_ARGS, "."],
    cwd: root,
    acceptedExitCodes: [0, 1]
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

interface GrepCandidateEvidence {
  readonly candidate: GrepCandidate
  readonly computedCandidate: GrepCandidate
  readonly messageId?: string
  readonly stringSyntax: boolean
}

interface GrepCandidateDraft {
  readonly file: string
  readonly declaration: string
  readonly construct: string
  readonly analyzerOccurrence?: number
  readonly messageId?: string
  readonly line: number
  readonly excerpt?: string
  readonly offset: number
  readonly matchedText: string
  readonly stringSyntax: boolean
}

const occurrenceRange = (occurrence: { readonly node: unknown }) => {
  if (!isSourceNode(occurrence.node)) return undefined
  const [start, end] = occurrence.node.range ?? []
  return start === undefined || end === undefined ? undefined : { start, end }
}

const collectGrepCandidates = Effect.fn("effect-audit.collect-grep-candidates")(
  function* (options: {
    readonly root: string
    readonly output: string
    readonly trackedFiles: ReadonlySet<string>
    readonly indexedFiles: ReadonlySet<string>
  }) {
    const path = yield* Path.Path
    const matches: Array<typeof RipgrepMatchData.Type> = []
    for (const [index, line] of options.output.split(/\r?\n/).entries()) {
      if (line.length === 0) continue
      const event = yield* decodeJson(RipgrepEventJson, line, `grep-json line ${index + 1}`)
      if (event.type === "match") {
        matches.push(yield* decodeJson(RipgrepMatchData, event.data, `grep-json match ${index + 1}`))
      }
    }

    const parsedFiles = new Map<string, ParsedSource>()
    const indexedLines = new Map<string, ReadonlyArray<IndexedSourceLine>>()
    const sourceCoordinates = new Set<string>()
    const drafts: Array<GrepCandidateDraft> = []
    for (const match of matches) {
      const file = normalizeFile(path, options.root, match.path.text)
      if (file === undefined || !options.trackedFiles.has(file) || !options.indexedFiles.has(file)) continue
      let parsed = parsedFiles.get(file)
      if (parsed === undefined) {
        parsed = yield* parseSource(options.root, file, "invalid-output")
        parsedFiles.set(file, parsed)
        indexedLines.set(file, indexSourceLines(parsed.source))
      }
      const line = indexedLines.get(file)?.at(match.line_number - 1)
      if (line === undefined) {
        return yield* Effect.fail(auditError("invalid-output", `grep-json line number is out of range in ${file}:${match.line_number}`))
      }
      if (match.absolute_offset !== line.byteOffset) {
        return yield* Effect.fail(auditError("invalid-output", `grep-json absolute offset does not resolve in ${file}:${match.line_number}`))
      }
      if (match.lines.text !== line.text) {
        return yield* Effect.fail(auditError("invalid-output", `grep-json line text does not resolve in ${file}:${match.line_number}`))
      }
      for (const submatch of match.submatches) {
        if (submatch.end < submatch.start) {
          return yield* Effect.fail(auditError("invalid-output", `grep-json has a reversed submatch in ${file}:${match.line_number}`))
        }
        if (submatch.end > line.byteLength) {
          return yield* Effect.fail(auditError("invalid-output", `grep-json submatch is out of range in ${file}:${match.line_number}`))
        }
        const startInLine = utf8ByteBoundaryToCodeUnit(line.text, submatch.start)
        const endInLine = utf8ByteBoundaryToCodeUnit(line.text, submatch.end)
        if (startInLine === undefined || endInLine === undefined) {
          return yield* Effect.fail(auditError("invalid-output", `grep-json submatch is not on UTF-8 boundaries in ${file}:${match.line_number}`))
        }
        if (match.lines.text.slice(startInLine, endInLine) !== submatch.match.text) {
          return yield* Effect.fail(auditError("invalid-output", `grep-json submatch text does not resolve in ${file}:${match.line_number}`))
        }
        const coordinate = [file, String(match.absolute_offset + submatch.start), String(match.absolute_offset + submatch.end)].join("\u0000")
        if (sourceCoordinates.has(coordinate)) {
          return yield* Effect.fail(auditError("invalid-output", `grep-json contains duplicate source coordinates in ${file}:${match.line_number}`))
        }
        sourceCoordinates.add(coordinate)
        const offset = line.codeUnitOffset + startInLine
        const endOffset = line.codeUnitOffset + endInLine
        const matching = parsed.analysis.occurrences
          .flatMap((occurrence) => {
            const range = occurrenceRange(occurrence)
            const score = matchingOccurrenceScore(submatch.match.text, occurrence.identity.construct)
            return range !== undefined && range.start <= offset && range.end >= endOffset && score >= 0
              ? [{ occurrence, range, score }]
              : []
          })
          .sort((left, right) => right.score - left.score || (left.range.end - left.range.start) - (right.range.end - right.range.start))
          .at(0)?.occurrence
        const fallback = matching === undefined
          ? parsed.analysis.identityAtOffset(offset, `lexical:${submatch.match.text}`)
          : undefined
        const identity = matching?.identity ?? fallback
        if (identity === undefined) {
          return yield* Effect.fail(auditError("invalid-output", `grep-json could not resolve ${file}:${match.line_number}`))
        }
        const excerpt = lineExcerpt(parsed.source, match.line_number)
        drafts.push({
          file,
          declaration: identity.declaration,
          construct: identity.construct,
          ...(matching === undefined ? {} : {
            analyzerOccurrence: identity.occurrence,
            messageId: matching.messageId
          }),
          line: match.line_number,
          ...(excerpt === undefined ? {} : { excerpt }),
          offset,
          matchedText: submatch.match.text,
          stringSyntax: matching === undefined && isStringSyntax(nodeAtOffset(parsed, offset))
        })
      }
    }

    drafts.sort((left, right) =>
      compareText(left.file, right.file)
      || left.offset - right.offset
      || compareText(left.matchedText, right.matchedText)
    )
    const lexicalCounts = new Map<string, number>()
    const boundaries = new Map(effectHostBoundaries.map((boundary) => [boundaryIdentityKey(boundary), boundary]))
    const evidence = drafts.map((draft) => {
      const lexicalKey = [draft.file, draft.declaration, draft.construct].join("\u0000")
      const occurrence = draft.analyzerOccurrence ?? lexicalCounts.get(lexicalKey) ?? 0
      if (draft.analyzerOccurrence === undefined) lexicalCounts.set(lexicalKey, occurrence + 1)
      const identity = [draft.file, draft.declaration, draft.construct, String(occurrence)].join("\u0000")
      const boundary = boundaries.get(identity)
      const candidate = new GrepCandidate({
        file: draft.file,
        declaration: draft.declaration,
        construct: draft.construct,
        occurrence,
        classification: boundary === undefined ? "migration-debt" : "host-boundary",
        rationale: boundary?.host ?? "",
        line: draft.line,
        ...(draft.excerpt === undefined ? {} : { excerpt: draft.excerpt })
      })
      return {
        candidate,
        computedCandidate: candidate,
        ...(draft.messageId === undefined ? {} : { messageId: draft.messageId }),
        stringSyntax: draft.stringSyntax
      } satisfies GrepCandidateEvidence
    }).sort((left, right) => compareText(grepCandidateKey(left.candidate), grepCandidateKey(right.candidate)))

    const validationError = grepInventoryValidationError(evidence.map(({ candidate }) => candidate))
    if (validationError !== undefined) return yield* Effect.fail(auditError("invalid-output", validationError))
    return evidence
  }
)

const hydrateGrepCandidates = (
  evidence: ReadonlyArray<GrepCandidateEvidence>,
  inventory: ReadonlyArray<GrepCandidate>
): ReadonlyArray<GrepCandidateEvidence> => {
  const inventoryByKey = new Map(inventory.map((candidate) => [grepCandidateKey(candidate), candidate]))
  return evidence.map((entry) => {
    const reviewed = inventoryByKey.get(grepCandidateKey(entry.candidate))
    if (reviewed === undefined || reviewed.classification === "migration-debt") return entry
    return {
      ...entry,
      candidate: new GrepCandidate({
        ...entry.computedCandidate,
        classification: reviewed.classification,
        rationale: reviewed.rationale
      })
    }
  })
}

const grepClassificationError = (evidence: ReadonlyArray<GrepCandidateEvidence>): string | undefined => {
  const boundaries = new Set(effectHostBoundaries.map(boundaryIdentityKey))
  for (const entry of evidence) {
    const { candidate } = entry
    if (candidate.classification === "migration-debt") continue
    if (candidate.rationale.trim().length === 0) {
      return `grep inventory ${candidate.classification} record requires a non-empty rationale: ${grepCandidateKey(candidate)}`
    }
    if (candidate.classification === "host-boundary") {
      if (entry.messageId !== "runnerOutsideBoundary" || !boundaries.has(grepCandidateKey(candidate))) {
        return `grep inventory host-boundary lacks an exact permanent boundary: ${grepCandidateKey(candidate)}`
      }
      continue
    }
    if (candidate.classification === "host-required-type") {
      if (entry.messageId !== "promiseSignature" || !candidate.construct.startsWith("signature:Promise")) {
        return `grep inventory host-required-type lacks analyzer proof: ${grepCandidateKey(candidate)}`
      }
      continue
    }
    if (candidate.classification === "audit-fixture") {
      if (entry.messageId !== undefined || !entry.stringSyntax || !isAuditFixturePath(candidate.file)) {
        return `grep inventory audit-fixture lacks fixture syntax proof: ${grepCandidateKey(candidate)}`
      }
      continue
    }
    if (entry.messageId !== undefined || entry.stringSyntax) {
      return `grep inventory false-positive lacks non-blocking analyzer proof: ${grepCandidateKey(candidate)}`
    }
  }
  return undefined
}

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

    const initialGrepEvidence = yield* collectGrepCandidates({
      root: options.root,
      output: output("grep-json"),
      trackedFiles: trackedSet,
      indexedFiles: eslintFileSet
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
    const grepInventoryFile = path.join(options.root, "effect-grep-inventory.json")
    const grepInventoryExists = yield* fs.exists(grepInventoryFile).pipe(
      Effect.mapError((error) => auditError("invalid-output", String(error)))
    )
    if (!grepInventoryExists) {
      return yield* Effect.fail(auditError("baseline-missing", "effect-grep-inventory.json does not exist"))
    }
    const grepInventoryRaw = yield* fs.readFileString(grepInventoryFile).pipe(
      Effect.mapError((error) => auditError("invalid-output", String(error)))
    )
    const grepInventory = yield* decodeJson(GrepInventoryJson, grepInventoryRaw, "grep inventory")
    const canonicalGrepInventory = yield* Schema.encodeEffect(GrepInventoryJson)(grepInventory).pipe(
      Effect.mapError((error) => auditError("invalid-output", String(error)))
    )
    if (grepInventoryRaw !== canonicalGrepInventory) {
      return yield* Effect.fail(auditError("invalid-output", "grep inventory is not in canonical byte form"))
    }
    const inventoryError = grepInventoryValidationError(grepInventory)
    if (inventoryError !== undefined) return yield* Effect.fail(auditError("invalid-output", inventoryError))
    const grepEvidence = hydrateGrepCandidates(initialGrepEvidence, grepInventory)
    const currentCandidates = grepEvidence.map(({ candidate }) => candidate)
    const currentError = grepInventoryValidationError(currentCandidates)
    if (currentError !== undefined) return yield* Effect.fail(auditError("invalid-output", currentError))
    const classificationError = grepClassificationError(grepEvidence)
    if (classificationError !== undefined) return yield* Effect.fail(auditError("invalid-output", classificationError))

    const grepCandidates = grepEvidence.map(({ candidate }) => candidate)
    const grepComparison = compareGrepInventory(grepInventory, grepCandidates)
    if (grepComparison.added.length > 0 || grepComparison.reclassified.length > 0) {
      return yield* Effect.fail(auditError(
        options.mode === "update" ? "baseline-growth" : "new-findings",
        `grep inventory has ${grepComparison.added.length} additions and ${grepComparison.reclassified.length} implicit reclassifications`
      ))
    }
    if (grepComparison.removed.some((candidate) => candidate.classification !== "migration-debt")) {
      return yield* Effect.fail(auditError(
        options.mode === "update" ? "baseline-growth" : "stale-baseline",
        "grep inventory has a stale non-debt record"
      ))
    }
    if (options.mode === "check" && grepComparison.removed.length > 0) {
      return yield* Effect.fail(auditError(
        "stale-baseline",
        `${grepComparison.removed.length} grep inventory records are stale`
      ))
    }
    const encodedBaseline = options.mode === "update"
      ? yield* Schema.encodeEffect(AuditBaselineJson)(findings).pipe(
        Effect.mapError((error) => auditError("invalid-output", String(error)))
      )
      : undefined
    let encodedGrepUpdate: string | undefined
    if (options.mode === "update" && grepComparison.removed.length > 0) {
      const currentKeys = new Set(grepCandidates.map(grepCandidateKey))
      const updatedInventory = grepInventory.filter((candidate) => currentKeys.has(grepCandidateKey(candidate)))
      encodedGrepUpdate = yield* Schema.encodeEffect(GrepInventoryJson)(updatedInventory).pipe(
        Effect.mapError((error) => auditError("invalid-output", String(error)))
      )
    }
    if (encodedBaseline !== undefined) {
      yield* fs.writeFileString(baselineFile, encodedBaseline).pipe(
        Effect.mapError((error) => auditError("invalid-output", String(error)))
      )
      if (encodedGrepUpdate !== undefined) {
        yield* fs.writeFileString(grepInventoryFile, encodedGrepUpdate).pipe(
          Effect.mapError((error) => auditError("invalid-output", String(error)))
        )
      }
    }
    const grepCounts = {
      "migration-debt": grepCandidates.filter((candidate) => candidate.classification === "migration-debt").length,
      "host-boundary": grepCandidates.filter((candidate) => candidate.classification === "host-boundary").length,
      "host-required-type": grepCandidates.filter((candidate) => candidate.classification === "host-required-type").length,
      "audit-fixture": grepCandidates.filter((candidate) => candidate.classification === "audit-fixture").length,
      "false-positive": grepCandidates.filter((candidate) => candidate.classification === "false-positive").length
    } as const
    yield* Effect.logInfo(
      `Effect grep inventory found ${grepCandidates.length} candidates: ${Object.entries(grepCounts).map(([classification, count]) => `${classification}=${count}`).join(", ")}`
    )
    return {
      findings,
      messages,
      added: comparison.added,
      removed: comparison.removed,
      updated: options.mode === "update",
      grepCandidates,
      grepAdded: grepComparison.added,
      grepRemoved: grepComparison.removed,
      grepCounts
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
