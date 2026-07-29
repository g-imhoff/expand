import { Data, Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "./effect-policy-model"

export class AuditFinding extends Schema.Class<AuditFinding>("AuditFinding")({
  engine: Schema.Literals(["effect-language-service", "eslint"]),
  file: Schema.String,
  rule: Schema.String,
  declaration: Schema.String,
  construct: Schema.String,
  occurrence: NonNegativeInt,
  severity: Schema.Literals(["error", "warning", "message"]),
  line: Schema.optionalKey(PositiveInt),
  excerpt: Schema.optionalKey(Schema.String)
}) {}

export class EffectAuditError extends Data.TaggedError("EffectAuditError")<{
  readonly reason:
    | "blocking-findings"
    | "command-failed"
    | "invalid-output"
    | "coverage-gap"
    | "invalid-boundary"
  readonly findings: ReadonlyArray<AuditFinding>
  readonly detail?: string
}> {}
