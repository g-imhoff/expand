import { useState } from "react"
import { useOptionalAutomationRpc } from "@expand/desktop/renderer/features/automations/data/automation-run-context"
import { useRunListPage } from "@expand/desktop/renderer/features/automations/data/use-run-history"
import {
  describeAutomationError,
  describeRunState,
  matchesRunSearch,
  runOutcomeOptions,
  type RunOutcomeFilter
} from "@expand/desktop/renderer/features/automations/model/run-history"

export interface RunHistoryListProps {
  readonly projectId: string
  readonly selectedRunId: string | undefined
  readonly onSelectRun: (runId: string | undefined) => void
}

export const RunHistoryList = ({ projectId, selectedRunId, onSelectRun }: RunHistoryListProps) => {
  const rpc = useOptionalAutomationRpc()
  const [query, setQuery] = useState("")
  const [outcome, setOutcome] = useState<RunOutcomeFilter>("all")
  const page = useRunListPage({ projectId, limit: 10, outcome })
  if (rpc === undefined) {
    return <p className="mt-2 text-sm text-muted-foreground">Run history isn't available yet.</p>
  }
  const visible = page.runs.filter((record) => matchesRunSearch(record, query))
  return (
    <div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <input
          aria-label="Search runs"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search runs"
          className="min-h-9 min-w-0 flex-1 rounded border px-2 text-sm"
        />
        <div role="group" aria-label="Outcome filters" className="flex min-w-0 flex-wrap gap-1">
          {runOutcomeOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={outcome === option.value}
              onClick={() => {
                setOutcome(option.value)
                onSelectRun(undefined)
              }}
              className="min-h-9 rounded border px-2 text-sm text-muted-foreground aria-pressed:font-medium aria-pressed:text-foreground"
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      {page.error !== undefined && (
        <p role="alert" className="mt-3 text-sm text-red-600">{describeAutomationError(page.error)}</p>
      )}
      {page.isPending && page.runs.length === 0 && (
        <p className="mt-3 text-sm text-muted-foreground">Loading runs.</p>
      )}
      {!page.isPending && page.error === undefined && page.runs.length === 0 && (
        <p className="mt-3 text-sm text-muted-foreground">{outcome === "all" ? "No runs yet." : "No runs match the current filter."}</p>
      )}
      {visible.length > 0 && (
        <ul aria-label="Automation runs" className="mt-3 divide-y rounded border">
          {visible.map((record) => (
            <li key={record.run.id}>
              <button
                type="button"
                onClick={() => onSelectRun(record.run.id)}
                aria-current={selectedRunId === record.run.id ? "true" : undefined}
                className="flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left text-sm aria-[current=true]:bg-muted"
              >
                <span className="font-medium">{record.run.id}</span>
                <span className="text-muted-foreground">
                  {record.run.configuration.routineId} rev {record.run.configuration.revision}
                </span>
                <span className="text-muted-foreground">{record.run.mode}</span>
                <span>{describeRunState(record.run)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {!page.isPending && page.runs.length > 0 && visible.length === 0 && page.error === undefined && (
        <p className="mt-3 text-sm text-muted-foreground">No runs match the current search.</p>
      )}
      <div className="mt-3 flex items-center gap-2 text-sm">
        <button
          type="button"
          onClick={page.previousPage}
          disabled={!page.hasPrevious || page.isPending}
          className="min-h-9 rounded border px-2 text-muted-foreground disabled:opacity-50"
        >
          Previous page
        </button>
        <span className="text-muted-foreground">Page {page.page}</span>
        <button
          type="button"
          onClick={page.nextPage}
          disabled={!page.hasNext || page.isPending}
          className="min-h-9 rounded border px-2 text-muted-foreground disabled:opacity-50"
        >
          Next page
        </button>
      </div>
    </div>
  )
}
