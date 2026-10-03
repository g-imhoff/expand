import { Schema } from "effect"
import type {
  ActionOutcome,
  AutomationFailure,
  AutomationRun,
  JevDecisionRequest,
  JevDecisionResult,
  PersonalScope
} from "@expand/contracts/automation"
import type { RoutineRecord, RunHistory, RunRecord } from "@expand/contracts/rpc/automation-schemas"

export interface RunOutcomeOption {
  readonly value: RunOutcomeFilter
  readonly label: string
}

export interface DecisionEvidence {
  readonly request: JevDecisionRequest | undefined
  readonly result: JevDecisionResult | undefined
  readonly error: AutomationFailure | undefined
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

export type RunOutcomeFilter = "all" | "completed" | "unresolved" | "failed" | "cancelled"

export const runOutcomeOptions: ReadonlyArray<RunOutcomeOption> = [
  { value: "all", label: "All" },
  { value: "completed", label: "Completed" },
  { value: "unresolved", label: "Unresolved" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" }
]

export const nothingChangedText = "Nothing changed"

export const automationScopeForProject = (projectId: string): PersonalScope => ({
  ownerId: "local",
  projectId
})

export const runStateForFilter = (
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

export const describeRunState = (run: AutomationRun): string => {
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

export const isUnresolvedRun = (record: RunRecord): boolean => record.run.state.kind === "unresolved"

export const matchesRunSearch = (record: RunRecord, query: string): boolean => {
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

export const plannedRunActions = (run: AutomationRun): ReadonlyArray<ActionOutcome> =>
  run.actions.filter((action) => action.kind === "planned")

export const appliedRunActions = (run: AutomationRun): ReadonlyArray<ActionOutcome> =>
  run.actions.filter((action) => action.kind !== "planned")

export const actionBadge = (action: ActionOutcome): "PLANNED" | "APPLIED" =>
  action.kind === "planned" ? "PLANNED" : "APPLIED"

export const decisionEvidenceForHistory = (history: RunHistory): DecisionEvidence => {
  const completed = history.attempts.filter((attempt) =>
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

export const issueInputForHistory = (history: RunHistory): IssueInput | undefined => {
  const evidence = decisionEvidenceForHistory(history)
  if (evidence.request === undefined) return undefined
  return issueInputForData(evidence.request.data)
}

export const issueInputForData = (data: unknown): IssueInput | undefined => {
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

export const providerFactsForDecision = (result: JevDecisionResult | undefined): ReadonlyArray<ProviderFact> => {
  if (result === undefined) return []
  if (result.kind === "abstained") return [{ label: "reason", value: result.reason }]
  const facts: Array<ProviderFact> = [{ label: "choice", value: result.outcomeId }]
  for (const fact of choiceFactsForData(result.data)) facts.push(fact)
  return facts
}

export const githubRepositoryForRoutine = (routine: RoutineRecord | undefined): GithubRepository | undefined => {
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

export const githubIssueUrl = (repository: GithubRepository, issueNumber: number): string =>
  `https://github.com/${repository.owner}/${repository.repo}/issues/${issueNumber}`

export const automationTestPathForRoutine = (projectId: string, routineId: string): string =>
  `/p/${projectId}/automations/routines/${routineId}/test`

export const toJsonText = (value: unknown): string => {
  try {
    return Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(value)
  } catch {
    return "unavailable"
  }
}

export const describeAutomationError = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as Record<string, unknown>)["message"]
    if (typeof message === "string" && message.length > 0) return message
  }
  return "Request failed"
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
