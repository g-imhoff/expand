import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Path, Schema } from "effect"
import { describe, expect } from "vitest"
import {
  CandidateInventoryError,
  CandidateInventoryJson,
  type CandidateObservation,
  candidateIdentity,
  collectCandidateAdvisories,
  collectCandidateGrep,
  validateCandidateRecords
} from "./effect-candidate-inventory"

const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString)

const observation = (overrides: Partial<CandidateObservation> = {}): CandidateObservation => ({
  candidate: {
    file: "src/example.ts",
    declaration: { kind: "variable", name: "value" },
    excerpt: "const value = Effect.catch(effect, recover)",
    match: ".catch(",
    occurrence: 0
  },
  construct: "lexical:.catch(",
  lexicalProof: "effect-member",
  stringSyntax: false,
  ...overrides
})

const inventory = (grep: ReadonlyArray<Record<string, unknown>>, advisories: ReadonlyArray<Record<string, unknown>> = []) => ({
  version: 1,
  grep,
  advisories
})

const lexical = (entry = observation().candidate) => ({
  ...entry,
  classification: { kind: "lexical-false-positive", reason: "effect-composition" }
})

const asyncMatch = ["as", "ync"].join("")
const awaitMatch = ["aw", "ait"].join("")
const jsonParseMatch = ["JSON", "parse"].join(".")
const jsonStringifyMatch = ["JSON", "stringify"].join(".")
const promiseLikeMatch = ["Promise", "Like<"].join("")
const nativePromiseMatch = ["new Pro", "mise"].join("")
const promiseChainMatch = [".", "then("].join("")
const nativeAsyncConstruct = ["native:as", "ync"].join("")
const nativeAwaitConstruct = ["native:aw", "ait"].join("")
const jsonParseConstruct = ["platform:JSON", "parse"].join(".")

const hostObservation = (
  match: string,
  messageId: string,
  construct: string,
  declaration: CandidateObservation["candidate"]["declaration"] = { kind: "variable", name: "value" }
): CandidateObservation => ({
  candidate: {
    file: "src/example.ts",
    declaration,
    excerpt: `const value = ${match}`,
    match,
    occurrence: 0
  },
  construct,
  analyzerOccurrence: 0,
  messageId,
  stringSyntax: false
})

const hostRecord = (entry: CandidateObservation, kind: "host-boundary" | "host-required-type" = "host-boundary") => ({
  ...entry.candidate,
  classification: {
    kind,
    hostBoundary: [
      entry.candidate.file,
      `${entry.candidate.declaration.kind}:${entry.candidate.declaration.name}`,
      entry.construct,
      entry.analyzerOccurrence
    ].join("#")
  }
})

const hostBoundary = (entry: CandidateObservation) => ({
  file: entry.candidate.file,
  declaration: `${entry.candidate.declaration.kind}:${entry.candidate.declaration.name}`,
  construct: entry.construct,
  occurrence: entry.analyzerOccurrence!
})

describe("final candidate inventory model", () => {
  it("Schema-decodes the exact versioned model without line identities", () => {
    const decoded = Schema.decodeUnknownSync(CandidateInventoryJson)(encodeJson(inventory([lexical()])))
    expect(decoded.version).toBe(1)
    expect(decoded.grep[0]).not.toHaveProperty("line")
    expect(() => Schema.decodeUnknownSync(CandidateInventoryJson)(encodeJson({ ...decoded, version: 2 }))).toThrow()
  })

  it.effect("rejects new, stale, duplicate, moved, and duplicate-excerpt candidates", () =>
    Effect.gen(function*() {
      const current = observation()
      const duplicate = { ...current, candidate: { ...current.candidate, occurrence: 1 } }
      const moved = { ...current, candidate: { ...current.candidate, excerpt: "const value = Effect.catch(effect, fallback)" } }
      const cases = [
        inventory([]),
        inventory([lexical(), lexical({ ...current.candidate, occurrence: 1 })]),
        inventory([lexical(), lexical()]),
        inventory([lexical(moved.candidate)]),
        inventory([lexical(duplicate.candidate)])
      ]
      for (const candidateInventory of cases) {
        const result = yield* Effect.exit(validateCandidateRecords(candidateInventory, [current], []))
        expect(result._tag).toBe("Failure")
      }
    }))

  it.effect("rejects bad host links, executable false positives, stale fixture rules, and stale rationales", () => {
    const executable = observation({ messageId: "nativePromise", construct: "promise-chain:catch", lexicalProof: "executable-call" })
    const executableWithoutMessage = observation({
      candidate: {
        ...observation().candidate,
        excerpt: "const encoded = JSON.stringify(value)",
        match: "JSON.stringify"
      },
      construct: "lexical:JSON.stringify",
      lexicalProof: "executable-call"
    })
    const nativeTimerWithoutMessage = observation({
      candidate: {
        ...observation().candidate,
        excerpt: "const handle = setTimeout(run, 1)",
        match: "setTimeout("
      },
      construct: "lexical:setTimeout(",
      lexicalProof: "executable-call"
    })
    const fixture = observation({
      candidate: { ...observation().candidate, file: "test/example.test.ts", excerpt: "const source = \"host().catch(use)\"" },
      stringSyntax: true
    })
    const cases = [
      [inventory([{ ...observation().candidate, classification: { kind: "host-boundary", hostBoundary: "bad" } }]), [observation()]],
      [inventory([lexical(executable.candidate)]), [executable]],
      [inventory([{ ...executableWithoutMessage.candidate, classification: { kind: "lexical-false-positive", reason: "non-executable-syntax" } }]), [executableWithoutMessage]],
      [inventory([{ ...nativeTimerWithoutMessage.candidate, classification: { kind: "lexical-false-positive", reason: "non-executable-syntax" } }]), [nativeTimerWithoutMessage]],
      [inventory([{ ...fixture.candidate, classification: { kind: "audit-fixture", expectedRule: "nativeAsync" } }]), [fixture]],
      [inventory([{ ...observation().candidate, classification: { kind: "lexical-false-positive", reason: "stale" } }]), [observation()]]
    ] as const
    return Effect.forEach(cases, ([candidateInventory, observations]) =>
      Effect.gen(function*() {
        const result = yield* Effect.exit(validateCandidateRecords(candidateInventory, observations, []))
        expect(result._tag).toBe("Failure")
      }))
  })

  it.effect("accepts only exact analyzer-proven native and JSON host links", () => {
    const entries = [
      hostObservation(asyncMatch, "nativeAsync", nativeAsyncConstruct),
      hostObservation(awaitMatch, "nativeAwait", nativeAwaitConstruct),
      hostObservation(jsonParseMatch, "platformEffect", jsonParseConstruct)
    ].sort((left, right) => {
      const leftKey = candidateIdentity(left.candidate)
      const rightKey = candidateIdentity(right.candidate)
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
    })
    return validateCandidateRecords(
      inventory(entries.map((entry) => hostRecord(entry))),
      entries,
      [],
      new Map(),
      entries.map(hostBoundary)
    ).pipe(Effect.asVoid)
  })

  it.effect("rejects inexact, unproved, and misclassified host links", () => {
    const exact = hostObservation(jsonParseMatch, "platformEffect", jsonParseConstruct)
    const nativePromise = hostObservation(nativePromiseMatch, "nativePromise", "promise:new")
    const promiseChain = hostObservation(promiseChainMatch, "promiseChain", "promise-chain:then")
    const executableJson = observation({
      candidate: { ...exact.candidate, excerpt: `const value = ${jsonParseMatch}(raw)` },
      construct: `lexical:${jsonParseMatch}`,
      lexicalProof: "executable-call"
    })
    const promiseSignature = hostObservation(promiseLikeMatch, "promiseSignature", "signature:PromiseLike")
    const arbitraryMessage = hostObservation(jsonParseMatch, "arbitrary", jsonParseConstruct)
    const wrongNativeConstruct = hostObservation(asyncMatch, "nativeAsync", nativeAwaitConstruct)
    const { analyzerOccurrence: _analyzerOccurrence, ...withoutProof } = exact
    const wrongBoundaries = [
      { ...hostBoundary(exact), file: "src/moved.ts" },
      { ...hostBoundary(exact), declaration: "variable:moved" },
      { ...hostBoundary(exact), construct: `platform:${jsonStringifyMatch}` },
      { ...hostBoundary(exact), occurrence: 1 }
    ]
    const cases = [
      ...wrongBoundaries.map((boundary) => [hostRecord(exact), exact, [boundary]] as const),
      [hostRecord(exact), withoutProof, [hostBoundary(exact)]] as const,
      [hostRecord(arbitraryMessage), arbitraryMessage, [hostBoundary(arbitraryMessage)]] as const,
      [hostRecord(wrongNativeConstruct), wrongNativeConstruct, [hostBoundary(wrongNativeConstruct)]] as const,
      [hostRecord(nativePromise), nativePromise, [hostBoundary(nativePromise)]] as const,
      [hostRecord(promiseChain), promiseChain, [hostBoundary(promiseChain)]] as const,
      [hostRecord(executableJson), executableJson, [hostBoundary(executableJson)]] as const,
      [hostRecord(promiseSignature), promiseSignature, [hostBoundary(promiseSignature)]] as const
    ]
    return Effect.forEach(cases, ([record, current, boundaries]) =>
      Effect.gen(function*() {
        const result = yield* Effect.exit(validateCandidateRecords(inventory([record]), [current], [], new Map(), boundaries))
        expect(result._tag).toBe("Failure")
      }))
  })

  it.effect("keeps Promise signatures in the host-required-type model", () => {
    const entry = hostObservation(promiseLikeMatch, "promiseSignature", "signature:PromiseLike")
    return validateCandidateRecords(
      inventory([hostRecord(entry, "host-required-type")]),
      [entry],
      [],
      new Map(),
      [hostBoundary(entry)]
    ).pipe(Effect.asVoid)
  })

  it.effect("rejects unknown advisories and stale advisory rationales", () => {
    const advisory = {
      file: "src/example.ts",
      declaration: { kind: "variable", name: "value" },
      rule: "effectFnOpportunity" as const,
      excerpt: "const value = Effect.succeed(1)",
      occurrence: 0
    }
    return Effect.gen(function*() {
      const unknown = yield* Effect.exit(validateCandidateRecords(inventory([], []), [], [{ ...advisory, rule: "unknown" }]))
      expect(unknown._tag).toBe("Failure")
      const stale = yield* Effect.exit(validateCandidateRecords(
        inventory([], [{ ...advisory, rationale: "small-expression" }]),
        [],
        [advisory],
        new Map([[candidateIdentity(advisory), "local-composition"]])
      ))
      expect(stale._tag).toBe("Failure")
    })
  })
})

it.effect("candidate advisory collector rejects every non-opportunity message", () =>
  Effect.scoped(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "expand-candidate-advisory-" })
    const file = "fixture.js"
    yield* fs.writeFileString(path.join(root, file), "export const sample = 1\n")
    const messages = [
      "effectSucceedWithVoid",
      "schemaStructWithTag",
      "unnecessaryEffectGen",
      "unnecessaryFailYieldableError",
      "nodeBuiltinImport",
      "arbitraryUnknownMessage"
    ]
    for (const name of messages) {
      const output = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)({ diagnostics: [{
        file,
        start: 0,
        line: 1,
        severity: "message",
        name,
        message: name
      }] })
      const error = yield* collectCandidateAdvisories({ root, output }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(CandidateInventoryError)
      expect(error.detail).toContain(name)
    }
  })).pipe(Effect.provide(NodeServices.layer)))

it.effect("collector positively distinguishes executable pattern calls from non-executable syntax", () =>
  Effect.scoped(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "expand-candidate-proof-" })
    const file = "fixture.js"
    const source = [
      "const encoded = JSON.stringify(value)",
      "const delayed = setTimeout(run, 1)",
      "const pending = Deferred.await",
      ""
    ].join("\n")
    yield* fs.writeFileString(path.join(root, file), source)
    const lines = source.trimEnd().split("\n")
    let absoluteOffset = 0
    const events = (yield* Effect.forEach(lines, (line, index) => Effect.gen(function*() {
      const terms = index === 0 ? ["JSON.stringify"] : index === 1 ? ["setTimeout("] : ["await"]
      const submatches = terms.map((term) => {
        const start = line.indexOf(term)
        return { match: { text: term }, start, end: start + term.length }
      })
      const event = {
        type: "match",
        data: {
          path: { text: file },
          lines: { text: `${line}\n` },
          line_number: index + 1,
          absolute_offset: absoluteOffset,
          submatches
        }
      }
      absoluteOffset += line.length + 1
      return yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(event)
    }))).join("\n")
    const observations = yield* collectCandidateGrep({ root, output: events, trackedFiles: new Set([file]) })

    const byMatch = new Map(observations.map((entry) => [entry.candidate.match, entry]))
    expect(byMatch.get("JSON.stringify")?.lexicalProof).toBe("executable-call")
    expect(byMatch.get("setTimeout(")?.messageId).toBe("platformEffect")
    expect(byMatch.get("await")?.lexicalProof).toBe("member-name")
  })).pipe(Effect.provide(NodeServices.layer)))

it.effect("accepts one exact analyzer-proven lexical candidate", () =>
  validateCandidateRecords(inventory([lexical()]), [observation()], []).pipe(
    Effect.provide(NodeServices.layer)
  ))
