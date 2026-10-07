import { Link } from "@tanstack/react-router"
import { automationRoutes } from "@expand/desktop/renderer/features/automations/model/automation-routes"
import type { AutomationOverviewData } from "@expand/desktop/renderer/features/automations/data/use-automation-overview"

export interface AutomationOverviewViewProps {
  readonly projectId: string
  readonly status: "loading" | "ready" | "error"
  readonly data: AutomationOverviewData | null
  readonly error: string | null
  readonly live: boolean
  readonly onRefresh: () => void
}

export const AutomationOverviewView = ({
  projectId,
  status,
  data,
  error,
  live,
  onRefresh
}: AutomationOverviewViewProps) => (
  <>
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold">Overview</h1>
        <p className="mt-3 text-sm text-muted-foreground">Routine states, recent runs, and outcome counts for this project.</p>
      </div>
      <div className="flex items-center gap-2">
        <Link
          to={automationRoutes["routine-setup"]}
          params={{ projectId }}
          className="inline-flex min-h-10 items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Add routine
        </Link>
        <button
          type="button"
          onClick={onRefresh}
          className="inline-flex min-h-10 items-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Refresh
        </button>
      </div>
    </div>
    <p className="mt-3 text-sm text-muted-foreground">{live ? "Live updates on" : "Connecting to live updates…"}</p>
    {error !== null && (
      <p role="alert" className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm">
        {error}{" "}
        <button type="button" onClick={onRefresh} className="underline">Retry</button>
      </p>
    )}
    {status === "loading" && data === null ? (
      <p className="mt-6 text-sm text-muted-foreground">Loading automations…</p>
    ) : data === null ? null : (
      <>
        <section aria-label="Run summary" className="mt-8">
          <h2 className="text-lg font-semibold">Summary</h2>
          <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {summaryEntries(data).map(({ label, testId, value }) => (
              <div key={testId} className="rounded-md border px-4 py-3">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd data-testid={testId} className="mt-1 text-2xl font-semibold">{value}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section aria-label="Routines" className="mt-8">
          <h2 className="text-lg font-semibold">Routines ({data.routines.length})</h2>
          {data.routines.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No routines yet. Add a routine to automate this project.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {data.routines.map((routine) => (
                <li key={routine.routineId} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-4 py-3">
                  <span className="text-sm font-medium">{routine.routineId}</span>
                  <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">{routine.head.status}</span>
                  <span className="text-xs text-muted-foreground">revision {routine.head.revision}</span>
                  <div className="ml-auto flex items-center gap-3">
                    <Link
                      to={automationRoutes["routine-edit"]}
                      params={{ projectId, routineId: routine.routineId }}
                      aria-label={`Edit routine ${routine.routineId}`}
                      className="inline-flex min-h-10 items-center text-sm underline hover:text-primary focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                      Edit
                    </Link>
                    <Link
                      to={automationRoutes["routine-test"]}
                      params={{ projectId, routineId: routine.routineId }}
                      aria-label={`Test routine ${routine.routineId}`}
                      className="inline-flex min-h-10 items-center text-sm underline hover:text-primary focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                      Test
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-label="Recent runs" className="mt-8">
          <h2 className="text-lg font-semibold">Recent runs</h2>
          {data.runs.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No runs yet.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {data.runs.map((record) => (
                <li key={record.run.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-4 py-3">
                  <span className="text-sm font-medium">{record.run.id}</span>
                  <span className="text-sm text-muted-foreground">{record.run.configuration.routineId}</span>
                  <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">{record.run.state.kind}</span>
                  <span className="text-xs text-muted-foreground">{record.run.mode}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <nav aria-label="Automation sections" className="mt-8 flex flex-wrap gap-x-4 gap-y-2">
          <Link
            to={automationRoutes.history}
            params={{ projectId }}
            className="text-sm text-muted-foreground underline hover:text-foreground"
          >
            View history
          </Link>
          <Link
            to={automationRoutes.integrations}
            params={{ projectId }}
            className="text-sm text-muted-foreground underline hover:text-foreground"
          >
            Manage integrations
          </Link>
        </nav>
      </>
    )}
  </>
)

const summaryEntries = (data: AutomationOverviewData): ReadonlyArray<{ readonly label: string; readonly testId: string; readonly value: number }> => [
  { label: "Total runs", testId: "metric-total", value: data.metrics.total },
  { label: "Succeeded", testId: "metric-succeeded", value: data.metrics.succeeded },
  { label: "Failed", testId: "metric-failed", value: data.metrics.failed },
  { label: "Unresolved", testId: "metric-unresolved", value: data.metrics.unresolved },
  { label: "Queued", testId: "metric-queued", value: data.metrics.queued },
  { label: "Running", testId: "metric-running", value: data.metrics.running },
  { label: "Cancelled", testId: "metric-cancelled", value: data.metrics.cancelled }
]
