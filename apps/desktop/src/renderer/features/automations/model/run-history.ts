import { Schema } from "effect"
import {
  ActionOutcome,
  AutomationFailure,
  ConfigurationReference,
  DefinitionReference,
  IntegrationReference,
  JevDecisionRequest,
  JevDecisionResult,
  JsonValue,
  LocalId,
  PersonalScope,
  PositiveVersion,
  RunState,
  type ActionOutcome as ActionOutcomeType,
  type AutomationFailure as AutomationFailureType,
  type AutomationRun,
  type JevDecisionRequest as JevDecisionRequestType,
  type JevDecisionResult as JevDecisionResultType,
  type PersonalScope as PersonalScopeType
} from "@expand/contracts/automation"
import type { RoutineRecord, RunHistory, RunRecord } from "@expand/contracts/rpc/automation-schemas"

export interface RunOutcomeOption {
  readonly value: RunOutcomeFilter
  readonly label: string
}

export interface DecisionEvidence {
  readonly request: JevDecisionRequestType | undefined
  readonly result: JevDecisionResultType | undefined
  readonly error: AutomationFailureType | undefined
  readonly latencyMs: number | undefined
}

export interface IssueInput {
  readonly issueNumber: number
  readonly title: string
  readonly body?: string | undefined
}

export interface GithubRepository {
  readonly owner: string
  readonly repo: string
}

export interface ProviderFact {
  readonly label: string
  readonly value: string
}

export {
  type RunOutcomeFilter,
  runOutcomeOptions,
  nothingChangedText,
  automationScopeForProject,
  runStateForFilter,
  describeRunState,
  matchesRunSearch,
  actionBadge,
  HistoryAttempt,
  HistoryJob,
  attemptsForHistory,
  jobForHistory,
  decisionEvidenceForHistory,
  issueInputForHistory,
  providerFactsForDecision,
  githubRepositoryForRoutine,
  githubIssueUrl,
  automationTestPathForRoutine,
  toJsonText,
  describeAutomationError
}

type RunOutcomeFilter = "all" | "completed" | "unresolved" | "failed" | "cancelled"

const runOutcomeOptions: ReadonlyArray<RunOutcomeOption> = [
  { value: "all", label: "All" },
  { value: "completed", label: "Completed" },
  { value: "unresolved", label: "Unresolved" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" }
]

const nothingChangedText = "Nothing changed"

const automationScopeForProject = (projectId: string): PersonalScopeType => ({
  ownerId: "local",
  projectId
})

const runStateForFilter = (
  filter: RunOutcomeFilter
): "succeeded" | "unresolved" | "failed" | "cancelled" | undefined => {
  switch (filter) {
    case "completed":
      return "succeeded"
    case "unresolved":
      return "unresolved"
    case "failed":
      return "failed"
    case "cancelled":
      return "cancelled"
    default:
      return undefined
  }
}

const describeRunState = (run: AutomationRun): string => {
  switch (run.state.kind) {
    case "succeeded":
      return "Completed"
    case "unresolved":
      return "Unresolved"
    case "failed":
      return "Failed"
    case "cancelled":
      return "Cancelled"
    case "running":
      return "Running"
    default:
      return "Queued"
  }
}

const matchesRunSearch = (record: RunRecord, query: string): boolean => {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return true
  const haystacks = [
    record.run.id,
    record.run.configuration.routineId,
    record.run.input.id,
    record.run.mode,
    record.run.state.kind,
    describeRunState(record.run)
  ]
  return haystacks.some((entry) => entry.toLowerCase().includes(needle))
}

const actionBadge = (action: ActionOutcomeType): "PLANNED" | "APPLIED" | "FAILED" | "SKIPPED" => {
  switch (action.kind) {
    case "planned":
      return "PLANNED"
    case "succeeded":
      return "APPLIED"
    case "failed":
      return "FAILED"
    case "skipped":
      return "SKIPPED"
  }
}

const AttemptBase = {
  id: LocalId,
  scope: PersonalScope,
  runId: LocalId,
  jobId: LocalId,
  stepId: LocalId,
  attempt: PositiveVersion,
  startedAt: LocalId
}

const JobCompletion = Schema.Struct({
  finishedAt: LocalId,
  result: Schema.optional(JsonValue),
  error: Schema.optional(AutomationFailure)
})

const HistoryAttempt = Schema.Union([
  Schema.Struct({ ...AttemptBase, kind: Schema.Literal("job"), status: Schema.Literal("started"), request: JsonValue }),
  Schema.Struct({ ...AttemptBase, kind: Schema.Literal("job"), status: Schema.Literal("completed"), request: JsonValue, completion: JobCompletion }),
  Schema.Struct({ ...AttemptBase, kind: Schema.Literal("decision"), status: Schema.Literal("started"), request: JevDecisionRequest }),
  Schema.Struct({
    ...AttemptBase,
    kind: Schema.Literal("decision"),
    status: Schema.Literal("completed"),
    request: JevDecisionRequest,
    finishedAt: LocalId,
    result: Schema.optional(JevDecisionResult),
    error: Schema.optional(AutomationFailure)
  }),
  Schema.Struct({
    ...AttemptBase,
    kind: Schema.Literal("action"),
    status: Schema.Literal("started"),
    integration: IntegrationReference,
    action: DefinitionReference,
    arguments: JsonValue
  }),
  Schema.Struct({
    ...AttemptBase,
    kind: Schema.Literal("action"),
    status: Schema.Literal("completed"),
    integration: IntegrationReference,
    action: DefinitionReference,
    arguments: JsonValue,
    finishedAt: LocalId,
    outcome: ActionOutcome
  })
])

type HistoryAttempt = typeof HistoryAttempt.Type

const HistoryJob = Schema.Struct({
  id: LocalId,
  scope: PersonalScope,
  runId: LocalId,
  configuration: ConfigurationReference,
  inputId: LocalId,
  mode: Schema.Literals(["preview", "live"]),
  state: RunState,
  metadata: JsonValue
})

type HistoryJob = typeof HistoryJob.Type

const attemptsForHistory = (history: RunHistory): ReadonlyArray<HistoryAttempt> => {
  const out: Array<HistoryAttempt> = []
  for (const value of history.attempts) {
    try {
      out.push(Schema.decodeUnknownSync(HistoryAttempt)(value))
    } catch {
      continue
    }
  }
  return out
}

const jobForHistory = (history: RunHistory): HistoryJob | undefined => {
  try {
    return Schema.decodeUnknownSync(HistoryJob)(history.job.job)
  } catch {
    return undefined
  }
}

const decisionEvidenceForHistory = (history: RunHistory): DecisionEvidence => {
  const completed = attemptsForHistory(history).filter((attempt) =>
    attempt.kind === "decision" && attempt.status === "completed"
  )
  const latest = completed.length === 0 ? undefined : completed[completed.length - 1]
  if (latest === undefined || latest.kind !== "decision" || latest.status !== "completed") {
    return { request: undefined, result: history.run.run.decision, error: undefined, latencyMs: undefined }
  }
  return {
    request: latest.request,
    result: latest.result ?? history.run.run.decision,
    error: latest.error,
    latencyMs: latencyForAttempt(latest.startedAt, latest.finishedAt)
  }
}

const issueInputForHistory = (history: RunHistory): IssueInput | undefined => {
  const evidence = decisionEvidenceForHistory(history)
  if (evidence.request === undefined) return undefined
  return issueInputForData(evidence.request.data)
}

const issueInputForData = (data: unknown): IssueInput | undefined => {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined
  const record = data as Record<string, unknown>
  const issueNumber = record["issueNumber"]
  const title = record["title"]
  const body = record["body"]
  if (typeof issueNumber !== "number" || !Number.isInteger(issueNumber) || issueNumber <= 0) return undefined
  if (typeof title !== "string" || title.length === 0) return undefined
  if (body !== undefined && typeof body !== "string") return undefined
  return body === undefined ? { issueNumber, title } : { issueNumber, title, body }
}

const providerFactsForDecision = (result: JevDecisionResultType | undefined): ReadonlyArray<ProviderFact> => {
  if (result === undefined) return []
  if (result.kind === "abstained") return [{ label: "reason", value: result.reason }]
  const facts: Array<ProviderFact> = [{ label: "choice", value: result.outcomeId }]
  for (const fact of choiceFactsForData(result.data)) facts.push(fact)
  return facts
}

const githubRepositoryForRoutine = (routine: RoutineRecord | undefined): GithubRepository | undefined => {
  if (routine === undefined) return undefined
  for (const integration of routine.configuration.integrations) {
    if (integration.definition.id !== "github:integration") continue
    const configuration = integration.configuration
    if (typeof configuration !== "object" || configuration === null || Array.isArray(configuration)) continue
    const record = configuration as Record<string, unknown>
    const owner = record["owner"]
    const repo = record["repo"]
    if (typeof owner === "string" && owner.length > 0 && typeof repo === "string" && repo.length > 0) {
      return { owner, repo }
    }
  }
  return undefined
}

const githubIssueUrl = (repository: GithubRepository, issueNumber: number): string =>
  `https://github.com/${repository.owner}/${repository.repo}/issues/${issueNumber}`

const automationTestPathForRoutine = (projectId: string, routineId: string): string =>
  `/p/${projectId}/automations/routines/${routineId}/test`

const toJsonText = (value: unknown): string => {
  try {
    return Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(sanitizeJsonValue(value))
  } catch {
    return "unavailable"
  }
}

const describeAutomationError = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as Record<string, unknown>)["message"]
    if (typeof message === "string" && message.length > 0) return message
  }
  return "Request failed"
}

const secretKeyPattern = /credential|secret|token|passwd|password|api[_-]?key|authorization|private[_-]?key/i

const sanitizeJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sanitizeJsonValue)
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = secretKeyPattern.test(key) ? "[redacted]" : sanitizeJsonValue(entry)
    }
    return out
  }
  return value
}

const latencyForAttempt = (startedAt: string, finishedAt: string): number | undefined => {
  const started = Number(startedAt)
  const finished = Number(finishedAt)
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) return undefined
  return finished - started
}

const choiceFactsForData = (data: unknown): ReadonlyArray<ProviderFact> => {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return []
  const record = data as Record<string, unknown>
  const facts: Array<ProviderFact> = []
  const confidence = record["confidence"]
  if (typeof confidence === "number" && Number.isFinite(confidence)) {
    facts.push({ label: "confidence", value: String(confidence) })
  }
  const probabilities = record["probabilities"]
  if (typeof probabilities === "object" && probabilities !== null && !Array.isArray(probabilities)) {
    facts.push({ label: "probabilities", value: toJsonText(probabilities) })
  }
  return facts
}
