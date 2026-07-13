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

const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))

export class ExecutableBoundary extends Schema.Class<ExecutableBoundary>("ExecutableBoundary")({
  file: Schema.String,
  mode: Schema.String,
  sourceSha256: Sha256,
  classification: Schema.Literals(["host-launcher", "host-fixture", "migration-debt"]),
  host: Schema.String
}) {}

export const LauncherInventoryJson = Schema.fromJsonString(Schema.Array(ExecutableBoundary))

export const executableBoundaryKey = (boundary: ExecutableBoundary): string => boundary.file

const validRepositoryRelativePath = (file: string): boolean =>
  file.length > 0
  && !file.startsWith("/")
  && !file.includes("\0")
  && !file.includes("\\")
  && !file.endsWith("/")
  && !/[*?\[\]{}]/.test(file)
  && file.split("/").every((part) => part !== "" && part !== "." && part !== "..")

export const launcherInventoryValidationError = (
  inventory: ReadonlyArray<ExecutableBoundary>
): string | undefined => {
  const keys = inventory.map(executableBoundaryKey)
  if (new Set(keys).size !== keys.length) return "launcher inventory contains duplicate paths"
  const sorted = [...keys].sort(compareText)
  if (keys.some((key, index) => key !== sorted[index])) return "launcher inventory is not sorted by path"
  if (inventory.some((boundary) => !validRepositoryRelativePath(boundary.file))) {
    return "launcher inventory contains a malformed repository-relative path"
  }
  if (inventory.some((boundary) => boundary.mode !== "100644" && boundary.mode !== "100755")) {
    return "launcher inventory contains an unsupported selected mode"
  }
  if (inventory.some((boundary) =>
    boundary.mode !== "100755" && !/\.(?:sh|bash|zsh)$/.test(boundary.file)
  )) return "launcher inventory contains a path not selected by launcher discovery"
  if (inventory.some((boundary) => !/^[0-9a-f]{64}$/.test(boundary.sourceSha256))) {
    return "launcher inventory contains an invalid SHA-256 fingerprint"
  }
  if (inventory.some((boundary) =>
    boundary.classification !== "host-launcher"
    && boundary.classification !== "host-fixture"
    && boundary.classification !== "migration-debt"
  )) return "launcher inventory contains an invalid classification"
  if (inventory.some((boundary) => boundary.host.length === 0 || boundary.host !== boundary.host.trim())) {
    return "launcher inventory records require a trimmed non-empty host"
  }
  return undefined
}

export const compareLauncherInventory = (
  expected: ReadonlyArray<ExecutableBoundary>,
  current: ReadonlyArray<ExecutableBoundary>
): {
  readonly added: ReadonlyArray<ExecutableBoundary>
  readonly removed: ReadonlyArray<ExecutableBoundary>
  readonly modeChanged: ReadonlyArray<ExecutableBoundary>
  readonly sourceChanged: ReadonlyArray<ExecutableBoundary>
  readonly reclassified: ReadonlyArray<ExecutableBoundary>
  readonly hostChanged: ReadonlyArray<ExecutableBoundary>
} => {
  const expectedByPath = new Map(expected.map((boundary) => [executableBoundaryKey(boundary), boundary]))
  const currentByPath = new Map(current.map((boundary) => [executableBoundaryKey(boundary), boundary]))
  return {
    added: current.filter((boundary) => !expectedByPath.has(executableBoundaryKey(boundary))),
    removed: expected.filter((boundary) => !currentByPath.has(executableBoundaryKey(boundary))),
    modeChanged: current.filter((boundary) => {
      const previous = expectedByPath.get(executableBoundaryKey(boundary))
      return previous !== undefined && previous.mode !== boundary.mode
    }),
    sourceChanged: current.filter((boundary) => {
      const previous = expectedByPath.get(executableBoundaryKey(boundary))
      return previous !== undefined && previous.sourceSha256 !== boundary.sourceSha256
    }),
    reclassified: current.filter((boundary) => {
      const previous = expectedByPath.get(executableBoundaryKey(boundary))
      return previous !== undefined && previous.classification !== boundary.classification
    }),
    hostChanged: current.filter((boundary) => {
      const previous = expectedByPath.get(executableBoundaryKey(boundary))
      return previous !== undefined && previous.host !== boundary.host
    })
  }
}

export const shrinkLauncherInventory = (
  expected: ReadonlyArray<ExecutableBoundary>,
  current: ReadonlyArray<ExecutableBoundary>
): ReadonlyArray<ExecutableBoundary> | undefined => {
  if (
    launcherInventoryValidationError(expected) !== undefined
    || launcherInventoryValidationError(current) !== undefined
  ) return undefined
  const comparison = compareLauncherInventory(expected, current)
  if (
    comparison.added.length > 0
    || comparison.removed.length === 0
    || comparison.modeChanged.length > 0
    || comparison.sourceChanged.length > 0
    || comparison.reclassified.length > 0
    || comparison.hostChanged.length > 0
  ) return undefined
  if (comparison.removed.some((boundary) => boundary.classification !== "migration-debt")) return undefined
  const currentPaths = new Set(current.map(executableBoundaryKey))
  return expected.filter((boundary) => currentPaths.has(executableBoundaryKey(boundary)))
}
