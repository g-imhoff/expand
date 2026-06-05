import { createHashHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router"
import { ProjectsView } from "@yodea/desktop/renderer/features/projects/projects-view"
import { Workspace } from "@yodea/desktop/renderer/app/shell/workspace"
import { RootLayout } from "@yodea/desktop/renderer/app/shell/root-layout"

const rootRoute = createRootRoute({ component: RootLayout })
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: ProjectsView })
const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/p/$projectId",
  component: Workspace
})

const routeTree = rootRoute.addChildren([indexRoute, projectRoute])
export const router = createRouter({ routeTree, history: createHashHistory() })

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}
