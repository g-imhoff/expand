import { Data, Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "./effect-policy-model"

export class AuditFinding extends Schema.Class<AuditFinding>("AuditFinding")({
  engine: Schema.Literals(["effect-language-service", "eslint"]),
  file: Schema.String,
  rule: Schema.String,
  declaration: Schema.String,
  construct: Schema.String,
  occurrence: NonNegativeInt,
  severity: Schema.Literals(["error", "message"]),
  line: Schema.optionalKey(PositiveInt),
  excerpt: Schema.optionalKey(Schema.String)
}) {}

export class EffectAuditError extends Data.TaggedError("EffectAuditError")<{
  readonly reason:
    | "baseline-missing"
    | "baseline-growth"
    | "command-failed"
    | "invalid-output"
    | "new-findings"
    | "stale-baseline"
    | "coverage-gap"
    | "invalid-boundary"
  readonly findings: ReadonlyArray<AuditFinding>
  readonly detail?: string
}> {}

export const findingKey = (finding: AuditFinding): string => [
  finding.engine,
  finding.file,
  finding.rule,
  finding.declaration,
  finding.construct,
  String(finding.occurrence)
].join("\u0000")

const blockingByKey = (findings: ReadonlyArray<AuditFinding>) => new Map(
  findings
    .filter((finding) => finding.severity === "error")
    .map((finding) => [findingKey(finding), finding])
)

const sortedMissing = (
  source: ReadonlyMap<string, AuditFinding>,
  target: ReadonlyMap<string, AuditFinding>
) => [...source]
  .filter(([key]) => !target.has(key))
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([, finding]) => finding)

export const compareAudit = (
  baseline: ReadonlyArray<AuditFinding>,
  current: ReadonlyArray<AuditFinding>
): {
  readonly added: ReadonlyArray<AuditFinding>
  readonly removed: ReadonlyArray<AuditFinding>
} => {
  const expected = blockingByKey(baseline)
  const actual = blockingByKey(current)
  return {
    added: sortedMissing(actual, expected),
    removed: sortedMissing(expected, actual)
  }
}

export const canUpdateBaseline = (
  baseline: ReadonlyArray<AuditFinding>,
  current: ReadonlyArray<AuditFinding>
): boolean => compareAudit(baseline, current).added.length === 0

export const AuditBaselineJson = Schema.fromJsonString(Schema.Array(AuditFinding))
