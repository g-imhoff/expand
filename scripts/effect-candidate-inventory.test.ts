import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import {
  CandidateInventoryJson,
  type CandidateObservation,
  candidateIdentity,
  validateCandidateRecords
} from "./effect-candidate-inventory"

const observation = (overrides: Partial<CandidateObservation> = {}): CandidateObservation => ({
  candidate: {
    file: "src/example.ts",
    declaration: { kind: "variable", name: "value" },
    excerpt: "const value = Effect.catch(effect, recover)",
    match: ".catch(",
    occurrence: 0
  },
  construct: "lexical:.catch(",
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

describe("final candidate inventory model", () => {
  it("Schema-decodes the exact versioned model without line identities", () => {
    const decoded = Schema.decodeUnknownSync(CandidateInventoryJson)(JSON.stringify(inventory([lexical()])))
    expect(decoded.version).toBe(1)
    expect(decoded.grep[0]).not.toHaveProperty("line")
    expect(() => Schema.decodeUnknownSync(CandidateInventoryJson)(JSON.stringify({ ...decoded, version: 2 }))).toThrow()
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
    const executable = observation({ messageId: "nativePromise", construct: "promise-chain:catch" })
    const fixture = observation({
      candidate: { ...observation().candidate, file: "test/example.test.ts", excerpt: "const source = \"host().catch(use)\"" },
      stringSyntax: true
    })
    const cases = [
      [inventory([{ ...observation().candidate, classification: { kind: "host-boundary", hostBoundary: "bad" } }]), [observation()]],
      [inventory([lexical(executable.candidate)]), [executable]],
      [inventory([{ ...fixture.candidate, classification: { kind: "audit-fixture", expectedRule: "nativeAsync" } }]), [fixture]],
      [inventory([{ ...observation().candidate, classification: { kind: "lexical-false-positive", reason: "stale" } }]), [observation()]]
    ] as const
    return Effect.forEach(cases, ([candidateInventory, observations]) =>
      Effect.gen(function*() {
        const result = yield* Effect.exit(validateCandidateRecords(candidateInventory, observations, []))
        expect(result._tag).toBe("Failure")
      }))
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

it.effect("accepts one exact analyzer-proven lexical candidate", () =>
  validateCandidateRecords(inventory([lexical()]), [observation()], []).pipe(
    Effect.provide(NodeServices.layer)
  ))
