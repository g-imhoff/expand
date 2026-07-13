import { Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "./effect-policy-model"

export class GrepCandidate extends Schema.Class<GrepCandidate>("GrepCandidate")({
  file: Schema.String,
  declaration: Schema.String,
  construct: Schema.String,
  occurrence: NonNegativeInt,
  classification: Schema.Literals([
    "migration-debt",
    "host-boundary",
    "host-required-type",
    "audit-fixture",
    "false-positive"
  ]),
  rationale: Schema.String,
  line: Schema.optionalKey(PositiveInt),
  excerpt: Schema.optionalKey(Schema.String)
}) {}

export const GrepInventoryJson = Schema.fromJsonString(Schema.Array(GrepCandidate))

export const grepCandidateKey = (candidate: GrepCandidate): string =>
  [candidate.file, candidate.declaration, candidate.construct, String(candidate.occurrence)].join("\u0000")

const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0

export const grepInventoryValidationError = (
  inventory: ReadonlyArray<GrepCandidate>
): string | undefined => {
  const keys = inventory.map(grepCandidateKey)
  if (new Set(keys).size !== keys.length) return "grep inventory contains duplicate candidate identities"
  const sorted = [...keys].sort(compareText)
  if (keys.some((key, index) => key !== sorted[index])) return "grep inventory is not sorted by candidate identity"
  if (inventory.some((candidate) =>
    candidate.classification !== "migration-debt" && candidate.rationale.trim().length === 0
  )) return "grep inventory non-debt classifications require a non-empty rationale"
  return undefined
}

export const compareGrepInventory = (
  expected: ReadonlyArray<GrepCandidate>,
  current: ReadonlyArray<GrepCandidate>
): {
  readonly added: ReadonlyArray<GrepCandidate>
  readonly removed: ReadonlyArray<GrepCandidate>
  readonly reclassified: ReadonlyArray<GrepCandidate>
} => {
  const expectedByKey = new Map(expected.map((candidate) => [grepCandidateKey(candidate), candidate]))
  const currentByKey = new Map(current.map((candidate) => [grepCandidateKey(candidate), candidate]))
  return {
    added: current.filter((candidate) => !expectedByKey.has(grepCandidateKey(candidate))),
    removed: expected.filter((candidate) => !currentByKey.has(grepCandidateKey(candidate))),
    reclassified: current.filter((candidate) => {
      const previous = expectedByKey.get(grepCandidateKey(candidate))
      return previous !== undefined && previous.classification !== candidate.classification
    })
  }
}

export const shrinkGrepInventory = (
  expected: ReadonlyArray<GrepCandidate>,
  current: ReadonlyArray<GrepCandidate>
): ReadonlyArray<GrepCandidate> | undefined => {
  if (grepInventoryValidationError(expected) !== undefined || grepInventoryValidationError(current) !== undefined) {
    return undefined
  }
  const comparison = compareGrepInventory(expected, current)
  if (comparison.added.length > 0 || comparison.reclassified.length > 0 || comparison.removed.length === 0) {
    return undefined
  }
  if (comparison.removed.some((candidate) => candidate.classification !== "migration-debt")) return undefined
  const expectedByKey = new Map(expected.map((candidate) => [grepCandidateKey(candidate), candidate]))
  if (current.some((candidate) => {
    const previous = expectedByKey.get(grepCandidateKey(candidate))
    return previous?.classification !== "migration-debt" && previous?.rationale !== candidate.rationale
  })) return undefined
  const currentKeys = new Set(current.map(grepCandidateKey))
  return expected.filter((candidate) => currentKeys.has(grepCandidateKey(candidate)))
}
