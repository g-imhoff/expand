import { Link, useParams } from "@tanstack/react-router"
import { useProjects } from "@expand/desktop/renderer/features/projects/data/use-projects"

export const Workspace = () => {
  const { projectId } = useParams({ from: "/p/$projectId" })
  const { data: projects = [] } = useProjects()
  const project = projects.find((p) => p.id === projectId)
  return (
    <main className="min-w-0 p-6 font-sans">
      <Link to="/" className="text-sm text-primary underline-offset-4 hover:underline">← Projects</Link>
      <h1 className="mt-6 break-words text-2xl font-semibold">{project ? project.name : "Unknown project"}</h1>
      <p className="mt-2 break-all text-sm text-muted-foreground">{projectId}</p>
    </main>
  )
}
