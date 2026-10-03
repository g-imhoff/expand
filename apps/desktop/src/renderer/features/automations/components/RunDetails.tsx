import type { ActionOutcome, Attempt, AutomationRun, Job } from "@expand/contracts/automation"
import { useOptionalAutomationRpc } from "@expand/desktop/renderer/features/automations/data/automation-run-context"
import { useRunDetails } from "@expand/desktop/renderer/features/automations/data/use-run-history"
import {
  actionBadge,
  automationTestPathForRoutine,
  decisionEvidenceForHistory,
  describeAutomationError,
  describeRunState,
  githubIssueUrl,
  githubRepositoryForRoutine,
  issueInputForHistory,
  nothingChangedText,
  providerFactsForDecision,
  toJsonText
} from "@expand/desktop/renderer/features/automations/model/run-history"

export interface RunDetailsProps {
  readonly projectId: string
  readonly runId: string | undefined
  readonly onBack: () => void
}

export const RunDetails = ({ projectId, runId, onBack }: RunDetailsProps) => {
  const rpc = useOptionalAutomationRpc()
  const details = useRunDetails(projectId, runId)
  if (rpc === undefined) {
    return <p className="mt-2 text-sm text-muted-foreground">Run details aren't available yet.</p>
  }
  if (runId === undefined) {
    return <p className="mt-2 text-sm text-muted-foreground">Select a run to inspect its evidence.</p>
  }
  if (details.isPending && details.history === undefined) {
    return <p className="mt-2 text-sm text-muted-foreground">Loading run.</p>
  }
  if (details.error !== undefined) {
    return (
      <div>
        <BackButton onBack={onBack} />
        <p role="alert" className="mt-3 text-sm text-red-600">{describeAutomationError(details.error)}</p>
      </div>
    )
  }
  const history = details.history
  if (history === undefined) {
    return (
      <div>
        <BackButton onBack={onBack} />
        <p className="mt-3 text-sm text-muted-foreground">No run data.</p>
      </div>
    )
  }
  const run = history.run.run
  const job = history.job.job
  const evidence = decisionEvidenceForHistory(history)
  const issue = issueInputForHistory(history)
  const repository = githubRepositoryForRoutine(details.routine)
  return (
    <div>
      <BackButton onBack={onBack} />
      <h2 className="mt-3 text-lg font-semibold">Run {run.id}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{describeRunState(run)} in {run.mode} mode</p>
      {run.state.kind === "unresolved" && (
        <p className="mt-3 rounded border px-3 py-2 text-sm">
          {nothingChangedText}: {run.state.reason}
        </p>
      )}
      <section aria-label="Original input" className="mt-6">
        <h3 className="text-sm font-semibold">Original input</h3>
        <p className="mt-1 text-sm text-muted-foreground">Input {run.input.id}</p>
        {issue !== undefined && (
          <div className="mt-2 text-sm">
            <p>GitHub issue #{issue.issueNumber}: {issue.title}</p>
            {issue.body !== undefined && <p className="mt-1 text-muted-foreground">{issue.body}</p>}
          </div>
        )}
        {evidence.request !== undefined && (
          <pre className="mt-2 overflow-auto rounded border p-2 text-xs">{toJsonText(evidence.request.data)}</pre>
        )}
      </section>
      <section aria-label="Routine revision" className="mt-6">
        <h3 className="text-sm font-semibold">Routine revision</h3>
        <p className="mt-1 text-sm">
          {run.configuration.routineId} rev {run.configuration.revision}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Exact configuration at run time: routine {run.configuration.routineId} revision {run.configuration.revision}
        </p>
      </section>
      <section aria-label="Provider evidence" className="mt-6">
        <h3 className="text-sm font-semibold">Provider evidence</h3>
        {evidence.request === undefined && <p className="mt-1 text-sm text-muted-foreground">No provider decision recorded.</p>}
        {evidence.request !== undefined && (
          <div className="mt-1 text-sm">
            <p>{evidence.request.provider} {evidence.request.model} {evidence.request.version}</p>
            <p className="text-muted-foreground">Candidates: {evidence.request.outcomes.join(", ")}</p>
            {evidence.result !== undefined && (
              <ul className="mt-1 list-disc pl-5">
                {providerFactsForDecision(evidence.result).map((fact) => (
                  <li key={fact.label}>{fact.label}: {fact.value}</li>
                ))}
              </ul>
            )}
            {evidence.latencyMs !== undefined && <p className="mt-1">Latency: {evidence.latencyMs} ms</p>}
            {evidence.error !== undefined && (
              <p className="mt-1 text-red-600">Decision error {evidence.error.code}: {evidence.error.message}</p>
            )}
          </div>
        )}
      </section>
      <section aria-label="Action timeline" className="mt-6">
        <h3 className="text-sm font-semibold">Action timeline</h3>
        {run.actions.length === 0 && <p className="mt-1 text-sm text-muted-foreground">No actions recorded.</p>}
        {run.actions.length > 0 && (
          <ul className="mt-1 divide-y rounded border text-sm">
            {run.actions.map((action) => (
              <li key={`${action.stepId}:${action.kind}`} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <span className="font-medium">{actionBadge(action)}</span>
                <span>{action.stepId}</span>
                <span className="text-muted-foreground">{describeActionOutcome(action)}</span>
              </li>
            ))}
          </ul>
        )}
        {history.attempts.length > 0 && (
          <ul aria-label="Attempts" className="mt-3 divide-y rounded border text-sm">
            {history.attempts.map((attempt) => (
              <li key={attempt.id} className="px-3 py-2">
                <span className="font-medium">{attempt.kind} {attempt.status}</span>
                <span className="text-muted-foreground"> {describeAttempt(attempt)}</span>
                {latencyTextForAttempt(attempt) !== undefined && (
                  <span className="text-muted-foreground"> ({latencyTextForAttempt(attempt)} ms)</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Results and errors" className="mt-6">
        <h3 className="text-sm font-semibold">Results and errors</h3>
        <div className="mt-1 text-sm">
          <p>Run: {describeRunOutcome(run)}</p>
          <p>Job: {describeJobOutcome(job)}</p>
        </div>
      </section>
      <nav aria-label="Run links" className="mt-6 flex flex-wrap gap-3 text-sm">
        {issue !== undefined && repository !== undefined && (
          <a
            href={githubIssueUrl(repository, issue.issueNumber)}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            Open GitHub issue #{issue.issueNumber}
          </a>
        )}
        <a href={`#${automationTestPathForRoutine(projectId, run.configuration.routineId)}`} className="underline">
          Re-test with updated rules
        </a>
      </nav>
    </div>
  )
}

const BackButton = ({ onBack }: { readonly onBack: () => void }) => (
  <button type="button" onClick={onBack} className="text-sm text-muted-foreground underline">
    Back to runs
  </button>
)

const describeActionOutcome = (action: ActionOutcome): string => {
  switch (action.kind) {
    case "planned":
      return toJsonText(action.arguments)
    case "succeeded":
      return toJsonText(action.result)
    case "failed":
      return `${action.error.code}: ${action.error.message}`
    default:
      return action.reason
  }
}

const describeAttempt = (attempt: Attempt): string => {
  switch (attempt.kind) {
    case "job":
      return attempt.status === "started"
        ? toJsonText(attempt.request)
        : toJsonText(attempt.completion)
    case "decision":
      if (attempt.status === "started") return `step ${attempt.stepId} attempt ${attempt.attempt}`
      if (attempt.result !== undefined) {
        return attempt.result.kind === "selected"
          ? `selected ${attempt.result.outcomeId}`
          : `abstained: ${attempt.result.reason}`
      }
      return attempt.error === undefined ? "no result" : `${attempt.error.code}: ${attempt.error.message}`
    default:
      if (attempt.status === "started") return `${attempt.stepId} ${toJsonText(attempt.arguments)}`
      return `${attempt.stepId} ${describeActionOutcome(attempt.outcome)}`
  }
}

const latencyTextForAttempt = (attempt: Attempt): number | undefined => {
  if (attempt.status !== "completed") return undefined
  const finishedAt = "finishedAt" in attempt ? attempt.finishedAt : undefined
  if (typeof finishedAt !== "string") return undefined
  const started = Number(attempt.startedAt)
  const finished = Number(finishedAt)
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) return undefined
  return finished - started
}

const describeRunOutcome = (run: AutomationRun): string => {
  switch (run.state.kind) {
    case "succeeded":
      return `Completed ${toJsonText(run.state.result)}`
    case "unresolved":
      return `${nothingChangedText}: ${run.state.reason}`
    case "failed":
      return `Failed ${run.state.error.code}: ${run.state.error.message}`
    case "cancelled":
      return `Cancelled: ${run.state.reason}`
    case "running":
      return "Running"
    default:
      return "Queued"
  }
}

const describeJobOutcome = (job: Job): string => {
  switch (job.state.kind) {
    case "succeeded":
      return `Completed ${toJsonText(job.state.result)}`
    case "unresolved":
      return `${nothingChangedText}: ${job.state.reason}`
    case "failed":
      return `Failed ${job.state.error.code}: ${job.state.error.message}`
    case "cancelled":
      return `Cancelled: ${job.state.reason}`
    case "running":
      return "Running"
    default:
      return "Queued"
  }
}
