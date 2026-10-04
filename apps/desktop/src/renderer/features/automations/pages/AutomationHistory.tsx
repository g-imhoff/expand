import { useState } from "react"
import { useParams } from "@tanstack/react-router"
import { RunDetails } from "@expand/desktop/renderer/features/automations/components/RunDetails"
import { RunHistoryList } from "@expand/desktop/renderer/features/automations/components/RunHistoryList"
import { useOptionalAutomationRpc } from "@expand/desktop/renderer/features/automations/data/automation-run-context"

export const AutomationHistory = () => {
  const { projectId } = useParams({ from: "/p/$projectId/automations" })
  const rpc = useOptionalAutomationRpc()
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(undefined)
  return (
    <>
      <h1 className="text-2xl font-semibold">History</h1>
      <p className="mt-3 text-sm text-muted-foreground">Review past automation runs.</p>
      {rpc === undefined ? (
        <p className="mt-2 text-sm text-muted-foreground">Run history isn't available yet.</p>
      ) : (
        <div className="mt-4 grid gap-8 lg:grid-cols-2">
          <RunHistoryList projectId={projectId} selectedRunId={selectedRunId} onSelectRun={setSelectedRunId} />
          <RunDetails projectId={projectId} runId={selectedRunId} onBack={() => setSelectedRunId(undefined)} />
        </div>
      )}
    </>
  )
}
