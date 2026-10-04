import { useParams } from "@tanstack/react-router"
import { AutomationOverviewView } from "@expand/desktop/renderer/features/automations/components/AutomationOverviewView"
import { useAutomationOverview } from "@expand/desktop/renderer/features/automations/data/use-automation-overview"

export const AutomationOverview = () => {
  const { projectId } = useParams({ from: "/p/$projectId/automations" })
  const model = useAutomationOverview(projectId)
  return (
    <AutomationOverviewView
      projectId={projectId}
      status={model.status}
      data={model.data}
      error={model.error}
      live={model.live}
      onRefresh={model.refresh}
    />
  )
}
