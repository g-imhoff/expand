import { Schema } from "effect"
import {
  AutomationFailure,
  AutomationRun,
  IntegrationConfiguration,
  JevDecisionRequest,
  JevDecisionResult,
  JsonValue,
  LocalId,
  PositiveVersion,
  RoutineConfiguration
} from "@expand/contracts/automation"

export class AutomationInvalid extends Schema.TaggedError<AutomationInvalid>()(
  "AutomationInvalid",
  { code: Schema.String, message: Schema.String }
) { }

export class AutomationConflict extends Schema.TaggedError<AutomationConflict>()(
  "AutomationConflict",
  { code: Schema.String, message: Schema.String }
) { }

export class AutomationNotFound extends Schema.TaggedError<AutomationNotFound>()(
  "AutomationNotFound",
  { code: Schema.String, message: Schema.String }
) { }

export class AutomationStorageFailed extends Schema.TaggedError<AutomationStorageFailed>()(
  "AutomationStorageFailed",
  { code: Schema.String, message: Schema.String }
) { }

export const AutomationErrorUnion = Schema.Union([
  AutomationInvalid,
  AutomationConflict,
  AutomationNotFound,
  AutomationStorageFailed
])

export const RoutineStatus = Schema.Literals(["enabled", "paused", "deleted"])
export type RoutineStatus = typeof RoutineStatus.Type

export const RoutineHead = Schema.Struct({
  revision: PositiveVersion,
  version: PositiveVersion,
  status: RoutineStatus
})
export type RoutineHead = typeof RoutineHead.Type

export const CredentialStatus = Schema.Struct({
  credentialId: LocalId, version: PositiveVersion, configured: Schema.Literal(true)
})
export type CredentialStatus = typeof CredentialStatus.Type

export const RoutineRecord = Schema.Struct({
  routineId: LocalId,
  head: RoutineHead,
  configuration: RoutineConfiguration,
  credentials: Schema.Array(CredentialStatus)
})
export type RoutineRecord = typeof RoutineRecord.Type

export const IntegrationRecord = Schema.Struct({
  configuration: IntegrationConfiguration,
  version: PositiveVersion
})
export type IntegrationRecord = typeof IntegrationRecord.Type

export const GithubConnectionStatus = Schema.Struct({
  ok: Schema.Boolean,
  configured: Schema.Boolean,
  owner: Schema.String,
  repo: Schema.String,
  labels: Schema.optional(Schema.Int),
  reason: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Int)
})
export type GithubConnectionStatus = typeof GithubConnectionStatus.Type

export const PreviewIssue = Schema.Struct({
  issueNumber: Schema.Int.check(Schema.isGreaterThan(0)),
  title: Schema.String.check(Schema.isMinLength(1)),
  body: Schema.optional(Schema.String)
})

export const PreviewAction = Schema.Struct({
  stepId: LocalId,
  arguments: JsonValue
})

export const PreviewClassified = Schema.Struct({
  kind: Schema.Literal("classified"),
  request: JevDecisionRequest,
  decision: JevDecisionResult,
  latencyMs: Schema.Number,
  outcomeId: LocalId,
  label: Schema.String,
  actions: Schema.Array(PreviewAction),
  executed: Schema.Literal(false)
})

export const PreviewUnresolved = Schema.Struct({
  kind: Schema.Literal("unresolved"),
  request: JevDecisionRequest,
  decision: JevDecisionResult,
  latencyMs: Schema.Number,
  reason: Schema.String,
  executed: Schema.Literal(false)
})

export const PreviewFailed = Schema.Struct({
  kind: Schema.Literal("failed"),
  request: JevDecisionRequest,
  error: AutomationFailure,
  latencyMs: Schema.Number,
  executed: Schema.Literal(false)
})

export const PreviewOutcome = Schema.Union([PreviewClassified, PreviewUnresolved, PreviewFailed])
export type PreviewOutcome = typeof PreviewOutcome.Type

export const RunRecord = Schema.Struct({
  run: AutomationRun,
  version: PositiveVersion,
  sequence: PositiveVersion
})
export type RunRecord = typeof RunRecord.Type

export const JobRecord = Schema.Struct({
  job: Schema.Unknown,
  version: PositiveVersion,
  sequence: PositiveVersion
})
export type JobRecord = typeof JobRecord.Type

export const RunHistory = Schema.Struct({
  run: RunRecord,
  job: JobRecord,
  attempts: Schema.Array(Schema.Unknown)
})
export type RunHistory = typeof RunHistory.Type

export const RunStateFilter = Schema.Literals([
  "queued",
  "running",
  "succeeded",
  "unresolved",
  "failed",
  "cancelled"
])

export const RunModeFilter = Schema.Literals(["preview", "live"])

export const RunPage = Schema.Struct({
  runs: Schema.Array(RunRecord),
  cursor: Schema.NullOr(Schema.String)
})
export type RunPage = typeof RunPage.Type

export const RunMetrics = Schema.Struct({
  total: Schema.Int,
  queued: Schema.Int,
  running: Schema.Int,
  succeeded: Schema.Int,
  unresolved: Schema.Int,
  failed: Schema.Int,
  cancelled: Schema.Int
})
export type RunMetrics = typeof RunMetrics.Type
