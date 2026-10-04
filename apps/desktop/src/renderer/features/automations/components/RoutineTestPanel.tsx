import { useState } from "react"
import type { PreviewOutcome } from "@expand/contracts/rpc/automation-schemas"
import { Input } from "@expand/desktop/renderer/components/ui/input"
import { Label } from "@expand/desktop/renderer/components/ui/label"
import {
  abstainChoice,
  type RoutineEditorForm
} from "@expand/desktop/renderer/features/automations/model/routine-editor"
import {
  describeAutomationError,
  toJsonText
} from "@expand/desktop/renderer/features/automations/model/run-history"

export interface PreviewRequestInput {
  readonly issueNumber: string
  readonly title: string
  readonly body: string
  readonly outcomeChoice: string
  readonly abstainReason: string
}

export interface RoutineTestPanelProps {
  readonly form: RoutineEditorForm
  readonly canPreview: boolean
  readonly blockedReason: string | undefined
  readonly isPending: boolean
  readonly outcome: PreviewOutcome | undefined
  readonly error: unknown
  readonly onPreview: (input: PreviewRequestInput) => void
}

export const RoutineTestPanel = ({
  form,
  canPreview,
  blockedReason,
  isPending,
  outcome,
  error,
  onPreview
}: RoutineTestPanelProps) => {
  const [issueNumber, setIssueNumber] = useState("42")
  const [title, setTitle] = useState("Login fails on retry")
  const [body, setBody] = useState("")
  const [outcomeChoice, setOutcomeChoice] = useState(form.categories[0]?.name.trim() ?? abstainChoice)
  const [abstainReason, setAbstainReason] = useState("No candidate matched the input")
  const [inputProblem, setInputProblem] = useState<string | undefined>(undefined)
  const categories = form.useDecision ? form.categories.map((category) => category.name.trim()).filter((name) => name.length > 0) : []
  const effectiveChoice = categories.includes(outcomeChoice) ? outcomeChoice : abstainChoice

  const runPreview = () => {
    if (!/^[1-9][0-9]*$/.test(issueNumber.trim())) {
      setInputProblem("Enter a positive issue number.")
      return
    }
    if (title.trim().length === 0) {
      setInputProblem("Enter an issue title.")
      return
    }
    setInputProblem(undefined)
    onPreview({ issueNumber: issueNumber.trim(), title: title.trim(), body, outcomeChoice: effectiveChoice, abstainReason })
  }

  return (
    <section aria-label="Test preview" className="mt-8">
      <h2 className="text-lg font-semibold">Test preview</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Send a sample issue through preview. Preview only proposes actions: nothing is applied or stored.
      </p>
      <div className="mt-3 grid max-w-xl gap-3">
        <div>
          <Label htmlFor="routine-preview-issue">Issue number</Label>
          <Input id="routine-preview-issue" value={issueNumber} onChange={(event) => setIssueNumber(event.target.value)} autoComplete="off" />
        </div>
        <div>
          <Label htmlFor="routine-preview-title">Issue title</Label>
          <Input id="routine-preview-title" value={title} onChange={(event) => setTitle(event.target.value)} autoComplete="off" />
        </div>
        <div>
          <Label htmlFor="routine-preview-body">Issue body (optional)</Label>
          <Input id="routine-preview-body" value={body} onChange={(event) => setBody(event.target.value)} autoComplete="off" />
        </div>
        <div>
          <Label htmlFor="routine-preview-decision">Simulated Jev decision</Label>
          <select
            id="routine-preview-decision"
            value={effectiveChoice}
            onChange={(event) => setOutcomeChoice(event.target.value)}
            className="min-h-9 w-full rounded border px-2 text-sm"
          >
            {categories.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
            <option value={abstainChoice}>No match (abstain)</option>
          </select>
        </div>
        {effectiveChoice === abstainChoice && (
          <div>
            <Label htmlFor="routine-preview-reason">Abstain reason</Label>
            <Input id="routine-preview-reason" value={abstainReason} onChange={(event) => setAbstainReason(event.target.value)} autoComplete="off" />
          </div>
        )}
      </div>
      <div className="mt-3">
        <button
          type="button"
          onClick={runPreview}
          disabled={!canPreview || isPending}
          className="min-h-9 rounded border px-3 text-sm disabled:opacity-50"
        >
          {isPending ? "Running preview…" : "Run preview"}
        </button>
        {!canPreview && blockedReason !== undefined && (
          <p className="mt-2 text-sm text-muted-foreground">{blockedReason}</p>
        )}
      </div>
      {inputProblem !== undefined && (
        <p role="alert" className="mt-2 text-sm text-red-600">{inputProblem}</p>
      )}
      {error !== undefined && (
        <p role="alert" className="mt-2 text-sm text-red-600">{describeAutomationError(error)}</p>
      )}
      {outcome !== undefined && <PreviewResult outcome={outcome} />}
    </section>
  )
}

export const PreviewResult = ({ outcome }: { readonly outcome: PreviewOutcome }) => {
  if (outcome.kind === "classified") {
    return (
      <div className="mt-3 rounded border px-3 py-2 text-sm">
        <p className="font-medium">Proposed outcome: {outcome.outcomeId}</p>
        <p className="mt-1">Proposed label: {outcome.label}</p>
        <p className="mt-1 text-muted-foreground">Preview only: not applied.</p>
        {outcome.actions.length === 0 ? (
          <p className="mt-2 text-muted-foreground">No actions proposed.</p>
        ) : (
          <ul aria-label="Proposed actions" className="mt-2 divide-y rounded border">
            {outcome.actions.map((action) => (
              <li key={action.stepId} className="px-3 py-2">
                <span className="font-medium">{action.stepId}</span>
                <pre className="mt-1 overflow-auto text-xs">{toJsonText(action.arguments)}</pre>
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }
  if (outcome.kind === "unresolved") {
    return (
      <div className="mt-3 rounded border px-3 py-2 text-sm">
        <p className="font-medium">No action proposed: {outcome.reason}</p>
        <p className="mt-1 text-muted-foreground">Preview only: nothing changed.</p>
      </div>
    )
  }
  return (
    <div className="mt-3 rounded border px-3 py-2 text-sm">
      <p role="alert" className="text-red-600">Preview failed: {outcome.error.message}</p>
      <p className="mt-1 text-muted-foreground">Preview only: nothing changed.</p>
    </div>
  )
}
