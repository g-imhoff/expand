import { useParams } from "@tanstack/react-router"
import { RoutineEditor } from "@expand/desktop/renderer/features/automations/components/RoutineEditor"

export const AutomationRoutineSetup = () => {
  const { projectId } = useParams({ from: "/p/$projectId/automations" })
  return (
    <>
      <h1 className="text-2xl font-semibold">Routine setup</h1>
      <p className="mt-3 text-sm text-muted-foreground">Choose when a routine runs and what it does.</p>
      <div className="mt-6">
        <RoutineEditor projectId={projectId} routineId={undefined} />
      </div>
    </>
  )
}
