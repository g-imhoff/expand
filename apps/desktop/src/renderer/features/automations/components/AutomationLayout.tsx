import { Link, Outlet, useNavigate, useParams, useRouterState } from "@tanstack/react-router"
import { useProjects } from "@expand/desktop/renderer/features/projects/data/use-projects"
import { AutomationNavigation } from "@expand/desktop/renderer/features/sidebar/components/AutomationNavigation"
import { automationPageForPath, automationRoutes } from "@expand/desktop/renderer/features/automations/model/automation-routes"

export const AutomationLayout = () => {
  const { projectId } = useParams({ from: "/p/$projectId/automations" })
  const { data: projects } = useProjects()
  const project = projects.find((item) => item.id === projectId)
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const activePage = automationPageForPath(pathname)
  const navigate = useNavigate()

  if (!project) {
    return (
      <section className="mx-auto w-full max-w-5xl px-6 py-8">
        <Link to="/" className="text-sm text-muted-foreground underline">Projects</Link>
        <h1 className="mt-6 text-2xl font-semibold">Unknown project</h1>
        <p className="mt-3 text-sm text-muted-foreground">Choose a project to open automations.</p>
      </section>
    )
  }

  return (
    <section className="mx-auto w-full min-w-0 max-w-5xl px-6 py-8">
      <header>
        <Link to="/p/$projectId" params={{ projectId }} className="text-sm text-muted-foreground underline">
          Back to workspace
        </Link>
        <p className="mt-6 break-words text-sm text-muted-foreground">{project.name}</p>
        {activePage !== null && (
          <AutomationNavigation
            activePage={activePage}
            onSelectPage={(page) => void navigate({ to: automationRoutes[page], params: { projectId } })}
            className="mt-3"
          />
        )}
      </header>
      <div className="py-8">
        <Outlet />
      </div>
    </section>
  )
}
