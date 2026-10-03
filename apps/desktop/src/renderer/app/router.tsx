import { createHashHistory, createRootRoute, createRoute, createRouter, type RouterHistory } from "@tanstack/react-router"
import { ProjectsView } from "@expand/desktop/renderer/features/projects/pages/ProjectsView"
import { Workspace } from "@expand/desktop/renderer/features/projects/pages/Workspace"
import { RootLayout } from "@expand/desktop/renderer/app/shell/root-layout"
import { AutomationLayout } from "@expand/desktop/renderer/features/automations/components/AutomationLayout"
import { AutomationOverview } from "@expand/desktop/renderer/features/automations/pages/AutomationOverview"
import { AutomationIntegrations } from "@expand/desktop/renderer/features/automations/pages/AutomationIntegrations"
import { AutomationRoutineSetup } from "@expand/desktop/renderer/features/automations/pages/AutomationRoutineSetup"
import { AutomationRoutineEdit } from "@expand/desktop/renderer/features/automations/pages/AutomationRoutineEdit"
import { AutomationHistory } from "@expand/desktop/renderer/features/automations/pages/AutomationHistory"

export const createAppRouter = (history: RouterHistory = createHashHistory()) => {
  const rootRoute = createRootRoute({ component: RootLayout })
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: ProjectsView })
  const projectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/p/$projectId",
    component: Workspace
  })

  const automationRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/p/$projectId/automations",
    component: AutomationLayout
  })
  const overviewRoute = createRoute({ getParentRoute: () => automationRoute, path: "/", component: AutomationOverview })
  const integrationsRoute = createRoute({ getParentRoute: () => automationRoute, path: "integrations", component: AutomationIntegrations })
  const routineSetupRoute = createRoute({ getParentRoute: () => automationRoute, path: "routines/new", component: AutomationRoutineSetup })
  const routineEditRoute = createRoute({ getParentRoute: () => automationRoute, path: "routines/$routineId", component: AutomationRoutineEdit })
  const routineTestRoute = createRoute({ getParentRoute: () => automationRoute, path: "routines/$routineId/test", component: AutomationRoutineEdit })
  const historyRoute = createRoute({ getParentRoute: () => automationRoute, path: "history", component: AutomationHistory })

  const routeTree = rootRoute.addChildren([
    indexRoute,
    projectRoute,
    automationRoute.addChildren([overviewRoute, integrationsRoute, routineSetupRoute, routineEditRoute, routineTestRoute, historyRoute])
  ])
  return createRouter({ routeTree, history })
}

export const router = createAppRouter()

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}
