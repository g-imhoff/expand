import { useParams, useRouterState } from "@tanstack/react-router"
import { RoutineEditor } from "@expand/desktop/renderer/features/automations/components/RoutineEditor"

export const AutomationRoutineEdit = () => {
  const { projectId } = useParams({ from: "/p/$projectId/automations" })
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const isTest = /\/routines\/[^/]+\/test\/?$/.test(pathname)
  const routineId = routineIdFromPath(pathname)
  if (routineId === undefined) {
    return (
      <>
        <h1 className="text-2xl font-semibold">Edit routine</h1>
        <p className="mt-3 text-sm text-muted-foreground">Choose when a routine runs and what it does.</p>
        <p role="alert" className="mt-2 text-sm text-red-600">No routine was selected.</p>
      </>
    )
  }
  return (
    <>
      <h1 className="text-2xl font-semibold">Edit routine</h1>
      <p className="mt-3 text-sm text-muted-foreground">Choose when a routine runs and what it does.</p>
      {isTest && (
        <p className="mt-2 text-sm text-muted-foreground">Test preview runs without changing anything.</p>
      )}
      <div className="mt-6">
        <RoutineEditor projectId={projectId} routineId={routineId} />
      </div>
    </>
  )
}

const routineIdFromPath = (pathname: string): string | undefined => {
  const match = /^\/p\/[^/]+\/automations\/routines\/([^/]+)(?:\/test)?\/?$/.exec(pathname)
  const routineId = match?.[1]
  return routineId === undefined || routineId === "new" ? undefined : routineId
}
