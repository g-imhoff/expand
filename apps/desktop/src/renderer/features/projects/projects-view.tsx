import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { useCreateProject, useProjects } from "@yodea/desktop/renderer/features/projects/use-projects"

export const ProjectsView = () => {
  const { data: projects = [], error } = useProjects()
  const create = useCreateProject()
  const [name, setName] = useState("")
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const n = name.trim()
    if (!n) return
    create.mutate(n, { onSuccess: () => setName("") })
  }
  return (
    <main style={{ fontFamily: "system-ui", padding: 24 }}>
      <h1>Yodea — Projects ({projects.length})</h1>
      <form onSubmit={submit}>
        <input
          aria-label="project name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="new project name"
        />
        <button type="submit">Create</button>
      </form>
      {(error || create.error) && (
        <p role="alert" style={{ color: "crimson" }}>{String(error ?? create.error)}</p>
      )}
      <ul data-testid="project-list">
        {projects.map((p) => (
          <li key={p.id}>
            <Link to="/p/$projectId" params={{ projectId: p.id }}>{p.name}</Link>{" "}
            <small style={{ opacity: 0.6 }}>{p.id}</small>
          </li>
        ))}
      </ul>
    </main>
  )
}
