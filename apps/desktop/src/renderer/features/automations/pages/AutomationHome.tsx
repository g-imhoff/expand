import { Link } from "@tanstack/react-router"
import { ArrowRight, FolderGit2, Zap } from "lucide-react"
import { useProjects } from "@expand/desktop/renderer/features/projects/data/use-projects"
import { automationRoutes } from "@expand/desktop/renderer/features/automations/model/automation-routes"

export const AutomationHome = () => {
  const { data: projects = [], error } = useProjects()
  const visibleProjects = projects.filter((project) => !project.archived)

  return (
    <section className="mx-auto w-full min-w-0 max-w-5xl px-6 py-8">
      <div className="flex items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Zap className="size-5" aria-hidden="true" />
        </span>
        <h1 className="text-2xl font-semibold">Automations</h1>
      </div>
      <p className="mt-3 text-sm text-muted-foreground">Choose a project to manage its automations.</p>
      {error ? (
        <p role="alert" className="mt-6 text-sm text-destructive">{String(error)}</p>
      ) : visibleProjects.length === 0 ? (
        <div className="mt-6 rounded-lg border bg-card p-6">
          <p className="text-sm text-muted-foreground">Create a project to set up your first automation.</p>
          <Link to="/" className="mt-4 inline-flex rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Create a project
          </Link>
        </div>
      ) : (
        <ul className="mt-6 grid gap-3">
          {visibleProjects.map((project) => (
            <li key={project.id}>
              <Link
                to={automationRoutes.overview}
                params={{ projectId: project.id }}
                aria-label={`Open automations for ${project.name}`}
                className="flex min-w-0 items-center gap-3 rounded-lg border bg-card p-4 hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <FolderGit2 className="size-5 shrink-0 text-primary" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{project.name}</span>
                  {project.directory && <span className="mt-1 block truncate text-xs text-muted-foreground">{project.directory}</span>}
                </span>
                <ArrowRight className="size-4 shrink-0 text-primary" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
