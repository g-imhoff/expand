import { Data, Effect, FileSystem, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import tseslint from "typescript-eslint"
import { analyzeEffectBoundaryProgram } from "../eslint-rules/effect-boundary-analysis.mjs"
import { effectHostBoundaries } from "../eslint-rules/effect-host-boundaries.mjs"

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const CandidateDeclaration = Schema.Struct({
  kind: Schema.String,
  name: Schema.String
})

const CandidateIdentity = Schema.Struct({
  file: Schema.String,
  declaration: CandidateDeclaration,
  excerpt: Schema.String,
  match: Schema.String,
  occurrence: NonNegativeInt
})

const CandidateClassification = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("host-boundary"), hostBoundary: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("host-required-type"), hostBoundary: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("audit-fixture"), expectedRule: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("lexical-false-positive"), reason: Schema.String })
])

export const CandidateRecord = Schema.Struct({
  ...CandidateIdentity.fields,
  classification: CandidateClassification
})

export const CandidateAdvisory = Schema.Struct({
  file: Schema.String,
  declaration: CandidateDeclaration,
  rule: Schema.Literal("effectFnOpportunity"),
  excerpt: Schema.String,
  occurrence: NonNegativeInt,
  rationale: Schema.Literals(["small-expression", "local-composition", "host-callback"])
})

export const CandidateInventory = Schema.Struct({
  version: Schema.Literal(1),
  grep: Schema.Array(CandidateRecord),
  advisories: Schema.Array(CandidateAdvisory)
})

export const CandidateInventoryJson = Schema.fromJsonString(CandidateInventory)

export type CandidateIdentityValue = typeof CandidateIdentity.Type
export type CandidateAdvisoryValue = Omit<typeof CandidateAdvisory.Type, "rationale">

export interface CandidateObservation {
  readonly candidate: CandidateIdentityValue
  readonly construct: string
  readonly analyzerOccurrence?: number
  readonly messageId?: string
  readonly stringSyntax: boolean
}

export class CandidateInventoryError extends Data.TaggedError("CandidateInventoryError")<{
  readonly detail: string
  readonly cause?: unknown
}> {}

const fail = (detail: string, cause?: unknown) => new CandidateInventoryError({
  detail,
  ...(cause === undefined ? {} : { cause })
})

export const candidateIdentity = (candidate: {
  readonly file: string
  readonly declaration: { readonly kind: string; readonly name: string }
  readonly excerpt: string
  readonly occurrence: number
  readonly match?: string
  readonly rule?: string
}) => [
  candidate.file,
  candidate.declaration.kind,
  candidate.declaration.name,
  candidate.excerpt,
  candidate.match ?? candidate.rule ?? "",
  String(candidate.occurrence)
].join("\u0000")

const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0

const boundaryKey = (boundary: {
  readonly file: string
  readonly declaration: string
  readonly construct: string
  readonly occurrence: number
}) => `${boundary.file}#${boundary.declaration}#${boundary.construct}#${boundary.occurrence}`

const declarationText = (declaration: CandidateIdentityValue["declaration"]) =>
  `${declaration.kind}:${declaration.name}`

const isAuditFixturePath = (file: string) =>
  /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[^/]+$/.test(file)
  || /^eslint-rules\/effect-(?:boundary|host-boundaries)/.test(file)
  || /^scripts\/effect-(?:audit|candidate-inventory|executable-inventory)/.test(file)

const fixtureRule = (match: string): string => {
  if (match === "async") return "nativeAsync"
  if (match === "await") return "nativeAwait"
  if (/^new\s+Promise\b|^Promise\./.test(match)) return "nativePromise"
  if (/^Promise(?:Like)?\s*</.test(match)) return "promiseSignature"
  if (/^\.(?:then|catch|finally)\s*\(/.test(match)) return "promiseChain"
  if (/\.run(?:Promise(?:Exit)?|Sync(?:Exit)?|Fork|Callback|Main)$/.test(match)) return "runnerOutsideBoundary"
  return "platformEffect"
}

const lexicalReason = (observation: CandidateObservation): string => {
  if (/^\.(?:catch|then|finally)\s*\(/.test(observation.candidate.match)) return "effect-composition"
  if (observation.candidate.match === "await") return "effect-member-or-text"
  return "non-executable-syntax"
}

const advisoryRationale = (advisory: { readonly excerpt: string }) => {
  if (/callback|listener|handler/i.test(advisory.excerpt)) return "host-callback" as const
  if (/=>|Effect\.(?:gen|flatMap|andThen|map)/.test(advisory.excerpt)) return "local-composition" as const
  return "small-expression" as const
}

export const validateCandidateRecords = Effect.fn("CandidateInventory.validateRecords")(
  function*(
    input: unknown,
    observations: ReadonlyArray<CandidateObservation>,
    advisoryObservations: ReadonlyArray<CandidateAdvisoryValue | (Omit<CandidateAdvisoryValue, "rule"> & { readonly rule: string })>,
    advisoryRationales: ReadonlyMap<string, "small-expression" | "local-composition" | "host-callback"> = new Map(),
    boundaries: ReadonlyArray<{
      readonly file: string
      readonly declaration: string
      readonly construct: string
      readonly occurrence: number
    }> = []
  ) {
    const inventory = yield* Schema.decodeUnknownEffect(CandidateInventory)(input).pipe(
      Effect.mapError((cause) => fail(`candidate inventory schema decode failed: ${String(cause)}`, cause))
    )
    const grepKeys = inventory.grep.map(candidateIdentity)
    const observationKeys = observations.map(({ candidate }) => candidateIdentity(candidate))
    if (new Set(grepKeys).size !== grepKeys.length) return yield* fail("candidate inventory contains duplicate grep identities")
    if (new Set(observationKeys).size !== observationKeys.length) return yield* fail("collector contains duplicate grep identities")
    const sortedGrep = [...grepKeys].sort(compareText)
    if (grepKeys.some((key, index) => key !== sortedGrep[index])) return yield* fail("candidate inventory grep records are not sorted")
    if (grepKeys.length !== observationKeys.length || grepKeys.some((key, index) => key !== [...observationKeys].sort(compareText)[index])) {
      return yield* fail("candidate inventory differs from collected grep candidates")
    }
    const observationByKey = new Map(observations.map((entry) => [candidateIdentity(entry.candidate), entry]))
    const boundariesByKey = new Map(boundaries.map((boundary) => [boundaryKey(boundary), boundary]))
    for (const record of inventory.grep) {
      const observation = observationByKey.get(candidateIdentity(record))!
      const classification = record.classification
      if (classification.kind === "host-boundary" || classification.kind === "host-required-type") {
        const boundary = boundariesByKey.get(classification.hostBoundary)
        if (
          boundary === undefined
          || boundary.file !== record.file
          || boundary.declaration !== declarationText(record.declaration)
          || boundary.construct !== observation.construct
          || boundary.occurrence !== observation.analyzerOccurrence
        ) return yield* fail(`candidate has a bad host link: ${candidateIdentity(record)}`)
        if (classification.kind === "host-boundary" && !["runnerOutsideBoundary", "platformEffect"].includes(observation.messageId ?? "")) {
          return yield* fail(`host candidate lacks executable analyzer proof: ${candidateIdentity(record)}`)
        }
        if (classification.kind === "host-required-type" && (
          observation.messageId !== "promiseSignature"
          || !observation.construct.startsWith("signature:Promise")
        )) return yield* fail(`host-required type lacks exact type-position proof: ${candidateIdentity(record)}`)
      } else if (classification.kind === "audit-fixture") {
        if (
          !observation.stringSyntax
          || !isAuditFixturePath(record.file)
          || classification.expectedRule !== fixtureRule(record.match)
        ) {
          return yield* fail(`audit fixture has a stale rule or is not exact string syntax: ${candidateIdentity(record)}`)
        }
      } else if (
        observation.messageId !== undefined
        || classification.reason !== lexicalReason(observation)
      ) return yield* fail(`lexical false positive lacks non-executable analyzer proof: ${candidateIdentity(record)}`)
    }

    if (advisoryObservations.some(({ rule }) => rule !== "effectFnOpportunity")) {
      return yield* fail("unknown language-service advisory")
    }
    const advisoryKeys = inventory.advisories.map(candidateIdentity)
    const currentAdvisoryKeys = advisoryObservations.map(candidateIdentity)
    if (new Set(advisoryKeys).size !== advisoryKeys.length) return yield* fail("candidate inventory contains duplicate advisories")
    const sortedAdvisories = [...advisoryKeys].sort(compareText)
    if (advisoryKeys.some((key, index) => key !== sortedAdvisories[index])) return yield* fail("candidate advisories are not sorted")
    if (
      advisoryKeys.length !== currentAdvisoryKeys.length
      || advisoryKeys.some((key, index) => key !== [...currentAdvisoryKeys].sort(compareText)[index])
    ) return yield* fail("candidate advisories differ from official diagnostics")
    const advisoryByKey = new Map(advisoryObservations.map((entry) => [candidateIdentity(entry), entry]))
    for (const advisory of inventory.advisories) {
      const observed = advisoryByKey.get(candidateIdentity(advisory))!
      const rationale = advisoryRationales.get(candidateIdentity(advisory)) ?? advisoryRationale(observed)
      if (advisory.rationale !== rationale) return yield* fail(`candidate advisory has stale rationale: ${candidateIdentity(advisory)}`)
    }
    return inventory
  }
)

export const EFFECT_CANDIDATE_PATTERN = String.raw`\basync\b|\bawait\b|new\s+Promise\b|\bPromise(?:Like)?\s*<|\bPromise\.(?:all|allSettled|any|race|resolve|reject)\b|\.(?:then|catch|finally)\s*\(|\b(?:setTimeout|setInterval|setImmediate|queueMicrotask|fetch)\s*\(|new\s+(?:Date|WebSocket|Worker|MessageChannel|BroadcastChannel)\s*\(|\b(?:console\.\w+|Date\.now|performance\.now|Math\.random|crypto\.randomUUID|JSON\.(?:parse|stringify)|process\.[A-Za-z_$][A-Za-z0-9_$]*|(?:window|document|navigator|localStorage|sessionStorage)\.)|\bnode:[^'"[:space:]]+|\b[A-Za-z_$][A-Za-z0-9_$]*\.run(?:Promise(?:Exit)?|Sync(?:Exit)?|Fork|Callback|Main)\b`

export const EFFECT_CANDIDATE_ROOTS = ["."] as const
export const EFFECT_CANDIDATE_EXCLUSIONS = [
  "!.git/**",
  "!**/node_modules/**",
  "!**/{dist,out,build,coverage,test-results,playwright-report}/**"
] as const
export const EFFECT_CANDIDATE_ARGS = [
  "-n",
  "--hidden",
  "-g",
  "*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
  ...EFFECT_CANDIDATE_EXCLUSIONS.flatMap((glob) => ["-g", glob]),
  EFFECT_CANDIDATE_PATTERN,
  ...EFFECT_CANDIDATE_ROOTS
] as const

export const EFFECT_CANDIDATE_HUMAN_COMMAND = [
  "rg -n --hidden -g '*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'",
  ...EFFECT_CANDIDATE_EXCLUSIONS.map((glob) => `-g '${glob}'`),
  `"${EFFECT_CANDIDATE_PATTERN.replaceAll("\\", "\\\\").replaceAll('\"', '\\\"')}"`
].join(" ")

const CandidateLanguageServiceJson = Schema.fromJsonString(Schema.Struct({
  diagnostics: Schema.Array(Schema.Struct({
    file: Schema.String,
    start: NonNegativeInt,
    line: Schema.Int,
    severity: Schema.Literals(["error", "message"]),
    name: Schema.String,
    message: Schema.String
  }))
}))

const RipgrepEventJson = Schema.fromJsonString(Schema.Struct({
  type: Schema.Literals(["begin", "match", "end", "summary"]),
  data: Schema.Unknown
}))

const RipgrepMatchData = Schema.Struct({
  path: Schema.Struct({ text: Schema.String }),
  lines: Schema.Struct({ text: Schema.String }),
  line_number: Schema.Int,
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

interface ParsedCandidateSource {
  readonly source: string
  readonly ast: SourceNode
  readonly visitorKeys?: Readonly<Record<string, ReadonlyArray<string>>>
  readonly analysis: ReturnType<typeof analyzeEffectBoundaryProgram>
}

const isSourceNode = (value: unknown): value is SourceNode =>
  typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"

const splitDeclaration = (declaration: string) => {
  const separator = declaration.indexOf(":")
  return separator < 0
    ? { kind: "unknown", name: declaration }
    : { kind: declaration.slice(0, separator), name: declaration.slice(separator + 1) }
}

interface CandidateParserResult {
  readonly ast: unknown
  readonly services?: unknown
  readonly scopeManager?: unknown
  readonly visitorKeys?: Readonly<Record<string, ReadonlyArray<string>>>
}

interface CandidateParser {
  readonly parseForESLint: (source: string, options: Record<string, unknown>) => CandidateParserResult
}

const candidateParser: CandidateParser = {
  parseForESLint: (source, options) => Reflect.apply(
    tseslint.parser.parseForESLint,
    tseslint.parser,
    [source, options]
  )
}

const parseCandidateSource = Effect.fn("CandidateInventory.parseSource")(
  function*(root: string, file: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const absolute = path.join(root, file)
    const source = yield* fs.readFileString(absolute).pipe(
      Effect.mapError((cause) => fail(`candidate source read failed: ${file}`, cause))
    )
    const parsed = yield* Effect.try({
      try: () => candidateParser.parseForESLint(source, {
        filePath: absolute,
        loc: true,
        range: true,
        sourceType: "module",
        ...(file.endsWith(".ts") || file.endsWith(".tsx") || file.endsWith(".mts") || file.endsWith(".cts")
          ? { project: "./tsconfig.effect-audit.json", tsconfigRootDir: root }
          : { project: false })
      }),
      catch: (cause) => fail(`candidate source parse failed: ${file}`, cause)
    })
    if (!isSourceNode(parsed.ast)) return yield* fail(`candidate source has no AST: ${file}`)
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
      catch: (cause) => fail(`candidate analyzer failed: ${file}`, cause)
    })
    return {
      source,
      ast: parsed.ast,
      ...(parsed.visitorKeys === undefined ? {} : { visitorKeys: parsed.visitorKeys }),
      analysis
    } satisfies ParsedCandidateSource
  }
)

const nodeAtOffset = (parsed: ParsedCandidateSource, offset: number): SourceNode | undefined => {
  const stack: Array<SourceNode> = [parsed.ast]
  let selected: SourceNode | undefined
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined) continue
    const [start, end] = node.range ?? []
    if (start !== undefined && end !== undefined && start <= offset && offset <= end) {
      const [selectedStart, selectedEnd] = selected?.range ?? []
      if (selectedStart === undefined || selectedEnd === undefined || end - start <= selectedEnd - selectedStart) selected = node
    }
    const keys = parsed.visitorKeys?.[node.type]
      ?? Object.keys(node).filter((key) => !["parent", "range", "loc", "tokens", "comments"].includes(key))
    for (const key of keys) {
      const value = node[key]
      if (Array.isArray(value)) {
        for (const child of value) if (isSourceNode(child)) stack.push(child)
      } else if (isSourceNode(value)) stack.push(value)
    }
  }
  return selected
}

const isStringSyntax = (node: SourceNode | undefined) =>
  node?.type === "TemplateElement"
  || node?.type === "TemplateLiteral"
  || (node?.type === "Literal" && typeof node.value === "string")

const utf8Boundary = (text: string, byteOffset: number): number | undefined => {
  let bytes = 0
  let codeUnits = 0
  for (const character of text) {
    if (bytes === byteOffset) return codeUnits
    const width = new TextEncoder().encode(character).length
    if (bytes + width > byteOffset) return undefined
    bytes += width
    codeUnits += character.length
  }
  return bytes === byteOffset ? codeUnits : undefined
}

const matchingScore = (matchedText: string, construct: string): number => {
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
  if (/^(?:console\.|Date\.now|performance\.now|Math\.random|crypto\.randomUUID|JSON\.|process\.|window\.|document\.|navigator\.|localStorage\.|sessionStorage\.)/.test(matchedText) && construct.startsWith("platform:")) return 100
  return -1
}

const occurrenceRange = (occurrence: { readonly node: unknown }) => {
  if (!isSourceNode(occurrence.node)) return undefined
  const [start, end] = occurrence.node.range ?? []
  return start === undefined || end === undefined ? undefined : { start, end }
}

export const collectCandidateGrep = Effect.fn("CandidateInventory.collectGrep")(
  function*(options: {
    readonly root: string
    readonly output: string
    readonly trackedFiles: ReadonlySet<string>
  }) {
    const path = yield* Path.Path
    const matches: Array<typeof RipgrepMatchData.Type> = []
    for (const [index, line] of options.output.split(/\r?\n/).entries()) {
      if (line.length === 0) continue
      const event = yield* Schema.decodeUnknownEffect(RipgrepEventJson)(line).pipe(
        Effect.mapError((cause) => fail(`ripgrep JSON line ${index + 1} is invalid`, cause))
      )
      if (event.type === "match") {
        matches.push(yield* Schema.decodeUnknownEffect(RipgrepMatchData)(event.data).pipe(
          Effect.mapError((cause) => fail(`ripgrep match ${index + 1} is invalid`, cause))
        ))
      }
    }
    const parsed = new Map<string, ParsedCandidateSource>()
    const drafts: Array<{
      readonly file: string
      readonly offset: number
      readonly declaration: { readonly kind: string; readonly name: string }
      readonly excerpt: string
      readonly match: string
      readonly construct: string
      readonly analyzerOccurrence?: number
      readonly messageId?: string
      readonly stringSyntax: boolean
    }> = []
    const coordinates = new Set<string>()
    for (const event of matches) {
      const relative = path.relative(options.root, path.isAbsolute(event.path.text) ? event.path.text : path.resolve(options.root, event.path.text)).split(path.sep).join("/")
      if (relative.startsWith("../") || !options.trackedFiles.has(relative)) continue
      let cached = parsed.get(relative)
      if (cached === undefined) {
        cached = yield* parseCandidateSource(options.root, relative)
        parsed.set(relative, cached)
      }
      const source = cached
      const lineStart = utf8Boundary(source.source, event.absolute_offset)
      if (
        event.line_number < 1
        || lineStart === undefined
        || source.source.slice(lineStart, lineStart + event.lines.text.length) !== event.lines.text
      ) return yield* fail(`ripgrep source coordinates do not resolve: ${relative}`)
      for (const submatch of event.submatches) {
        const start = utf8Boundary(event.lines.text, submatch.start)
        const end = utf8Boundary(event.lines.text, submatch.end)
        if (start === undefined || end === undefined || event.lines.text.slice(start, end) !== submatch.match.text) {
          return yield* fail(`ripgrep byte span does not resolve: ${relative}`)
        }
        const absolute = lineStart + start
        const coordinate = `${relative}\u0000${absolute}\u0000${absolute + (end - start)}`
        if (coordinates.has(coordinate)) return yield* fail(`ripgrep contains duplicate source coordinates: ${relative}`)
        coordinates.add(coordinate)
        const matching = source.analysis.occurrences.flatMap((occurrence) => {
          const range = occurrenceRange(occurrence)
          const score = matchingScore(submatch.match.text, occurrence.identity.construct)
          return range !== undefined && range.start <= absolute && range.end >= absolute + (end - start) && score >= 0
            ? [{ occurrence, range, score }]
            : []
        }).sort((left, right) => right.score - left.score || (left.range.end - left.range.start) - (right.range.end - right.range.start))[0]?.occurrence
        const fallback = matching === undefined
          ? source.analysis.identityAtOffset(absolute, `lexical:${submatch.match.text}`)
          : undefined
        const identity = matching?.identity ?? fallback
        if (identity === undefined) return yield* fail(`candidate declaration does not resolve: ${relative}`)
        drafts.push({
          file: relative,
          offset: absolute,
          declaration: splitDeclaration(identity.declaration),
          excerpt: event.lines.text.trim(),
          match: submatch.match.text,
          construct: identity.construct,
          ...(matching === undefined ? {} : { analyzerOccurrence: identity.occurrence, messageId: matching.messageId }),
          stringSyntax: matching === undefined && isStringSyntax(nodeAtOffset(source, absolute))
        })
      }
    }
    drafts.sort((left, right) => compareText(left.file, right.file) || left.offset - right.offset || compareText(left.match, right.match))
    const occurrences = new Map<string, number>()
    return drafts.map((draft) => {
      const key = [draft.file, draft.declaration.kind, draft.declaration.name, draft.excerpt, draft.match].join("\u0000")
      const occurrence = occurrences.get(key) ?? 0
      occurrences.set(key, occurrence + 1)
      return {
        candidate: {
          file: draft.file,
          declaration: draft.declaration,
          excerpt: draft.excerpt,
          match: draft.match,
          occurrence
        },
        construct: draft.construct,
        ...(draft.analyzerOccurrence === undefined ? {} : { analyzerOccurrence: draft.analyzerOccurrence }),
        ...(draft.messageId === undefined ? {} : { messageId: draft.messageId }),
        stringSyntax: draft.stringSyntax
      } satisfies CandidateObservation
    }).sort((left, right) => compareText(candidateIdentity(left.candidate), candidateIdentity(right.candidate)))
  }
)

const runChild = Effect.fn("CandidateInventory.runChild")(
  (root: string, command: string, args: ReadonlyArray<string>, accepted: ReadonlyArray<number>) =>
    Effect.scoped(Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const handle = yield* spawner.spawn(ChildProcess.make(command, args, { cwd: root })).pipe(
        Effect.mapError((cause) => fail(`${command} could not start`, cause))
      )
      const [stdout, stderr, exitCode] = yield* Effect.all([
        handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
        handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
        handle.exitCode
      ], { concurrency: "unbounded" }).pipe(Effect.mapError((cause) => fail(`${command} failed`, cause)))
      if (!accepted.includes(exitCode)) return yield* fail(`${command} exited ${exitCode}: ${stderr}`)
      return stdout
    }))
)

export const collectLiveCandidateGrep = Effect.fn("CandidateInventory.collectLiveGrep")(
  function*(root: string) {
    const trackedOutput = yield* runChild(root, "git", ["ls-files", "-z"], [0])
    const output = yield* runChild(root, "rg", ["--json", ...EFFECT_CANDIDATE_ARGS], [0, 1])
    return yield* collectCandidateGrep({ root, output, trackedFiles: new Set(trackedOutput.split("\0").filter(Boolean)) })
  }
)

export const collectLiveCandidateAdvisories = Effect.fn("CandidateInventory.collectLiveAdvisories")(
  function*(root: string) {
    const output = yield* runChild(root, "effect-language-service", [
      "diagnostics",
      "--project",
      "tsconfig.effect-audit.json",
      "--format",
      "json",
      "--severity",
      "error,message"
    ], [0, 1])
    const diagnostics = yield* Schema.decodeUnknownEffect(CandidateLanguageServiceJson)(output).pipe(
      Effect.mapError((cause) => fail("official language-service output is invalid", cause))
    )
    const path = yield* Path.Path
    const parsed = new Map<string, ParsedCandidateSource>()
    const counts = new Map<string, number>()
    const advisories: Array<CandidateAdvisoryValue | (Omit<CandidateAdvisoryValue, "rule"> & { readonly rule: string })> = []
    for (const diagnostic of diagnostics.diagnostics) {
      if (diagnostic.severity !== "message") continue
      const file = path.relative(root, path.isAbsolute(diagnostic.file) ? diagnostic.file : path.resolve(root, diagnostic.file)).split(path.sep).join("/")
      let source = parsed.get(file)
      if (source === undefined) {
        source = yield* parseCandidateSource(root, file)
        parsed.set(file, source)
      }
      const identity = source.analysis.identityAtOffset(diagnostic.start, `diagnostic:${diagnostic.name}`)
      const recognized = new Set([
        "effectSucceedWithVoid",
        "schemaStructWithTag",
        "unnecessaryEffectGen",
        "unnecessaryFailYieldableError"
      ])
      if (recognized.has(diagnostic.name)) continue
      if (diagnostic.name === "nodeBuiltinImport") {
        const occurrence = source.analysis.occurrences.find((entry) => {
          const range = occurrenceRange(entry)
          return entry.identity.construct.startsWith("platform:import:node:")
            && range !== undefined
            && range.start <= diagnostic.start
            && range.end >= diagnostic.start
        })
        const boundary = occurrence === undefined ? undefined : effectHostBoundaries.find((entry) =>
          entry.file === occurrence.identity.file
          && entry.declaration === occurrence.identity.declaration
          && entry.construct === occurrence.identity.construct
          && entry.occurrence === occurrence.identity.occurrence
        )
        if (boundary === undefined) return yield* fail(`unregistered node builtin diagnostic: ${file}`)
        continue
      }
      const separator = identity.declaration.indexOf(":")
      const declaration = separator < 0
        ? { kind: "unknown", name: identity.declaration }
        : { kind: identity.declaration.slice(0, separator), name: identity.declaration.slice(separator + 1) }
      const excerpt = source.source.split(/\r\n|[\n\r\u2028\u2029]/).at(diagnostic.line - 1)?.trim() ?? ""
      const key = [file, declaration.kind, declaration.name, excerpt, diagnostic.name].join("\u0000")
      const occurrence = counts.get(key) ?? 0
      counts.set(key, occurrence + 1)
      advisories.push({ file, declaration, rule: diagnostic.name, excerpt, occurrence })
    }
    return advisories.sort((left, right) => compareText(candidateIdentity(left), candidateIdentity(right)))
  }
)

export const validateCandidateInventory = Effect.fn("CandidateInventory.validate")(
  function*(root: string, suppliedAdvisories?: ReadonlyArray<CandidateAdvisoryValue>) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const raw = yield* fs.readFileString(path.join(root, "effect-candidate-inventory.json")).pipe(
      Effect.mapError((cause) => fail("candidate inventory could not be read", cause))
    )
    const inventory = yield* Schema.decodeUnknownEffect(CandidateInventoryJson)(raw).pipe(
      Effect.mapError((cause) => fail("candidate inventory JSON is invalid", cause))
    )
    const canonical = yield* Schema.encodeEffect(CandidateInventoryJson)(inventory).pipe(
      Effect.mapError((cause) => fail("candidate inventory could not be encoded", cause))
    )
    if (raw !== canonical) return yield* fail("candidate inventory is not in canonical byte form")
    const observations = yield* collectLiveCandidateGrep(root)
    const advisories = suppliedAdvisories ?? (yield* collectLiveCandidateAdvisories(root))
    return yield* validateCandidateRecords(inventory, observations, advisories, new Map(), effectHostBoundaries)
  }
)
