import { Link, useParams } from "@tanstack/react-router"
import { useProjects } from "@yodea/desktop/renderer/features/projects/use-projects"

export const Workspace = () => {
  const { projectId } = useParams({ from: "/p/$projectId" })
  const { data: projects = [] } = useProjects()
  const project = projects.find((p) => p.id === projectId)
  return (
    <main style={{ fontFamily: "system-ui", padding: 24 }}>
      <Link to="/">← Projects</Link>
      <h1>{project ? project.name : "Unknown project"}</h1>
      <p style={{ opacity: 0.6 }}>{projectId}</p>
      {/* Feature panels slot in here as the app grows. */}
    </main>
  )
}
