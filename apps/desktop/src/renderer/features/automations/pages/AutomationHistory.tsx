import { useParams } from "@tanstack/react-router"
import { AutomationNotifications } from "@expand/desktop/renderer/features/automations/components/AutomationNotifications"

export const AutomationHistory = () => {
  const { projectId } = useParams({ from: "/p/$projectId/automations/history" })
  return (
    <>
      <h1 className="text-2xl font-semibold">History</h1>
      <p className="mt-3 text-sm text-muted-foreground">Review past automation runs.</p>
      <p className="mt-2 text-sm text-muted-foreground">Run history isn't available yet.</p>
      <AutomationNotifications projectId={projectId} notifications={[]} onMarkRead={() => {}} />
    </>
  )
}
