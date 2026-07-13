import { Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "./effect-policy-model"

export const grepCandidateClassifications = [
  "migration-debt",
  "host-boundary",
  "host-required-type",
  "audit-fixture",
  "false-positive"
] as const

export class GrepCandidate extends Schema.Class<GrepCandidate>("GrepCandidate")({
  file: Schema.String,
  declaration: Schema.String,
  construct: Schema.String,
  occurrence: NonNegativeInt,
  classification: Schema.Literals(grepCandidateClassifications),
  rationale: Schema.String,
  line: Schema.optionalKey(PositiveInt),
  excerpt: Schema.optionalKey(Schema.String)
}) {}

export const GrepInventoryJson = Schema.fromJsonString(Schema.Array(GrepCandidate))

export const grepCandidateKey = (candidate: GrepCandidate): string => [
  candidate.file,
  candidate.declaration,
  candidate.construct,
  String(candidate.occurrence)
].join("\u0000")

const sortedByKey = (candidates: ReadonlyArray<GrepCandidate>) => [...candidates]
  .sort((left, right) => grepCandidateKey(left).localeCompare(grepCandidateKey(right)))

export const validateGrepInventory = (inventory: ReadonlyArray<GrepCandidate>): string | undefined => {
  const keys = inventory.map(grepCandidateKey)
  if (new Set(keys).size !== keys.length) return "grep inventory contains duplicate candidate keys"
  const sorted = [...keys].sort((left, right) => left.localeCompare(right))
  if (keys.some((key, index) => key !== sorted[index])) return "grep inventory is not sorted by candidate key"
  if (inventory.some((candidate) => candidate.classification !== "migration-debt"
    && candidate.rationale.trim().length === 0)) {
    return "grep inventory contains a reviewed classification without rationale"
  }
  return undefined
}

const candidatesByKey = (candidates: ReadonlyArray<GrepCandidate>) => new Map(
  candidates.map((candidate) => [grepCandidateKey(candidate), candidate])
)

const missingCandidates = (
  source: ReadonlyMap<string, GrepCandidate>,
  target: ReadonlyMap<string, GrepCandidate>
) => [...source]
  .filter(([key]) => !target.has(key))
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([, candidate]) => candidate)

export const compareGrepInventory = (
  inventory: ReadonlyArray<GrepCandidate>,
  current: ReadonlyArray<GrepCandidate>
): {
  readonly added: ReadonlyArray<GrepCandidate>
  readonly removed: ReadonlyArray<GrepCandidate>
} => {
  const expected = candidatesByKey(inventory)
  const actual = candidatesByKey(current)
  return {
    added: missingCandidates(actual, expected),
    removed: missingCandidates(expected, actual)
  }
}

export const prepareGrepInventoryUpdate = (
  inventory: ReadonlyArray<GrepCandidate>,
  current: ReadonlyArray<GrepCandidate>
): {
  readonly inventory: ReadonlyArray<GrepCandidate>
  readonly added: ReadonlyArray<GrepCandidate>
  readonly protectedRemoved: ReadonlyArray<GrepCandidate>
} => {
  const comparison = compareGrepInventory(inventory, current)
  const expected = candidatesByKey(inventory)
  const refreshed = current.flatMap((candidate) => {
    const previous = expected.get(grepCandidateKey(candidate))
    if (previous === undefined) return []
    return [new GrepCandidate({
      file: candidate.file,
      declaration: candidate.declaration,
      construct: candidate.construct,
      occurrence: candidate.occurrence,
      classification: previous.classification,
      rationale: previous.rationale,
      ...(candidate.line === undefined ? {} : { line: candidate.line }),
      ...(candidate.excerpt === undefined ? {} : { excerpt: candidate.excerpt })
    })]
  })
  return {
    inventory: sortedByKey(refreshed),
    added: comparison.added,
    protectedRemoved: comparison.removed.filter((candidate) => candidate.classification !== "migration-debt")
  }
}

export type GrepCandidateCounts = Record<(typeof grepCandidateClassifications)[number], number>

export const grepCandidateCounts = (inventory: ReadonlyArray<GrepCandidate>): GrepCandidateCounts => {
  const counts: GrepCandidateCounts = {
    "migration-debt": 0,
    "host-boundary": 0,
    "host-required-type": 0,
    "audit-fixture": 0,
    "false-positive": 0
  }
  for (const candidate of inventory) counts[candidate.classification] += 1
  return counts
}
