import { createHashHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router"
import { ProjectsView } from "@expand/desktop/renderer/features/projects/pages/ProjectsView"
import { Workspace } from "@expand/desktop/renderer/features/projects/pages/Workspace"
import { RootLayout } from "@expand/desktop/renderer/app/shell/root-layout"

export const router = (() => {
  const rootRoute = createRootRoute({ component: RootLayout })
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: ProjectsView })
  const projectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/p/$projectId",
    component: Workspace
  })

  const routeTree = rootRoute.addChildren([indexRoute, projectRoute])
  return createRouter({ routeTree, history: createHashHistory() })
})()

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}
